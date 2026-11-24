import { describe, it, expect, vi } from 'vitest'
import { SELF } from 'cloudflare:test'
import { createLiveQueryCollection, eq } from '@tanstack/db'
import type { SequencedBatch, WriteAck, WriteBatch } from '../../src/protocol.ts'
import { CLOSE_IDENTITY_CHANGED } from '../../src/protocol.ts'
import { createPartyDb } from '../../src/client/party-db.ts'
import type { OpenEvent, Transport } from '../../src/client/sync-client.ts'
import { ids as rowIds, partyUrl, roomHeader } from './helpers.ts'
import { remarks } from './worker.ts'

// Role grants at the wire, on a real DO: roles come from the token's claims, are
// pinned to the socket as partyserver tags at connect, and select the sockets a
// frame goes to. Every frame asserted here crossed the WebSocket.

const url = (room: string, query: Record<string, string> = {}) => partyUrl('reviewed', room, query)

async function connect(room: string, token?: string) {
  const res = await SELF.fetch(url(room, token ? { token } : {}), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const frames: SequencedBatch[] = []
  const closes: number[] = []
  ws.addEventListener('message', (e) => frames.push(JSON.parse(e.data as string)))
  ws.addEventListener('close', (e) => closes.push(e.code))
  // three collections, three snapshot frames
  await expect.poll(() => frames.filter((f) => f.reset).length).toBe(3)
  return { ws, frames, closes }
}

async function post(room: string, body: WriteBatch[], token?: string) {
  return SELF.fetch(url(room), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...roomHeader(room) },
    body: JSON.stringify(body),
  })
}

const op = (channel: string, type: 'insert' | 'update' | 'delete', value: Record<string, unknown>): WriteBatch[] => [{ channel, ops: [{ type, value }] }]
const ids = (frames: SequencedBatch[], channel: string) =>
  frames.filter((f) => f.channel === channel && !f.reset).flatMap((f) => f.ops.map((o) => `${o.type}:${o.value.id}`))

describe('role grants at the wire', () => {
  it('fans a draft out to editors only, and a note once to an editor who owns it', async () => {
    const room = 'roles-fanout'
    const [anon, bob, carol, alice] = [await connect(room), await connect(room, 'bob'), await connect(room, 'carol:editor'), await connect(room, 'alice')]
    expect((await post(room, op('drafts', 'insert', { id: 'd1', text: 'x' }), 'bob')).status).toBe(403)
    expect((await post(room, op('drafts', 'insert', { id: 'd1', text: 'x' }), 'carol:editor')).status).toBe(200)
    expect((await post(room, op('notes', 'insert', { id: 'n1', text: 'x' }), 'carol:editor')).status).toBe(200)
    expect((await post(room, op('notes', 'insert', { id: 'n2', text: 'x' }), 'alice')).status).toBe(200)
    await expect.poll(() => ids(carol.frames, 'notes')).toEqual(['insert:n1', 'insert:n2'])
    await expect.poll(() => ids(alice.frames, 'notes')).toEqual(['insert:n2'])
    expect(ids(carol.frames, 'drafts')).toEqual(['insert:d1'])
    for (const s of [anon, bob, alice]) expect(ids(s.frames, 'drafts')).toEqual([])
    for (const s of [anon, bob]) expect(ids(s.frames, 'notes')).toEqual([])
    for (const s of [anon, bob, carol, alice]) s.ws.close()
  })

  it("lets an editor override another user's review, and refuses a uid without the role", async () => {
    const room = 'roles-review'
    expect((await post(room, op('reviews', 'insert', { id: 'r1', text: 'good' }), 'alice')).status).toBe(200)
    expect((await post(room, op('reviews', 'update', { id: 'r1', text: 'mine' }), 'bob')).status).toBe(403)
    expect((await post(room, op('reviews', 'update', { id: 'r1', text: 'edited' }), 'carol:editor')).status).toBe(200)
    expect((await post(room, op('reviews', 'delete', { id: 'r1' }), 'carol:editor')).status).toBe(200)
  })

  it("closes a user's sockets for a changed identity, with the close code that drops the client's cursor", async () => {
    const room = 'roles-reconnect'
    const [bob, carol] = [await connect(room, 'bob'), await connect(room, 'carol:editor')]
    expect((await SELF.fetch(url(room, { reconnect: 'bob' }), { headers: roomHeader(room) })).status).toBe(200)
    await expect.poll(() => bob.closes).toEqual([CLOSE_IDENTITY_CHANGED])
    expect(carol.closes).toEqual([])
    carol.ws.close()
  })
})

// partysocket can't dial `SELF`, so this transport plays its part: on a 4001 close
// it redials with no `?since`, under whatever token `as` set last, and reports the
// open as an identity change.
async function redialing(room: string, token: string) {
  let current = token
  let ws: WebSocket | undefined
  let closed = false
  let redial: Promise<void> | undefined
  const listeners = new Set<(batch: SequencedBatch) => void>()
  const openers = new Set<(event?: OpenEvent) => void>()
  const dial = async (identityChanged: boolean) => {
    const res = await SELF.fetch(url(room, { token: current }), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
    const socket = res.webSocket!
    socket.accept()
    socket.addEventListener('message', (e) => {
      const batch = JSON.parse(e.data as string) as SequencedBatch
      for (const listener of listeners) listener(batch)
    })
    socket.addEventListener('close', (e) => {
      ws = undefined
      if (!closed && e.code === CLOSE_IDENTITY_CHANGED) redial = dial(true)
    })
    ws = socket
    for (const listener of openers) listener({ identityChanged })
  }
  await dial(false)
  const transport: Transport = {
    subscribe: (onBatch) => (listeners.add(onBatch), () => listeners.delete(onBatch)),
    async send(batches) {
      const res = await post(room, batches, current)
      if (!res.ok) throw new Error(`write rejected: ${res.status}`)
      return (await res.json()) as WriteAck
    },
    sendFrame: (frame) => ws?.send(JSON.stringify(frame)),
    isOpen: () => ws !== undefined,
    onOpen: (listener) => (openers.add(listener), () => openers.delete(listener)),
    close: () => ((closed = true), ws?.close()),
  }
  return { transport, as: (token: string) => void (current = token), redialed: () => redial }
}

describe('a sliced collection under a changed identity (#68)', () => {
  it('drops the rows the new identity cannot read', async () => {
    const room = 'roles-sliced-reconnect'
    const remark = (id: string, text: string): WriteBatch[] => [{ channel: 'remarks', ops: [{ type: 'insert', value: { id, thread_id: 'T', text } }] }]
    expect((await post(room, remark('r1', "alice's"), 'alice')).status).toBe(200)
    expect((await post(room, remark('r2', "carol's"), 'carol:editor')).status).toBe(200)

    const carol = await redialing(room, 'carol:editor')
    const { db, close } = createPartyDb(carol.transport, [remarks])
    const thread = createLiveQueryCollection((q) => q.from({ r: db.remarks }).where(({ r }) => eq(r.thread_id, 'T')))
    await thread.preload()
    expect(rowIds(thread)).toEqual(['r1', 'r2'])

    carol.as('carol') // the host takes away her editor role
    expect((await SELF.fetch(url(room, { reconnect: 'carol' }), { headers: roomHeader(room) })).status).toBe(200)
    await vi.waitFor(() => expect(carol.redialed()).toBeDefined())
    await carol.redialed()
    await vi.waitFor(() => expect(rowIds(thread)).toEqual(['r2']))
    expect(db.remarks.has('r1')).toBe(false)
    close()
  })
})
