import { describe, it, expect, vi } from 'vitest'
import { SELF } from 'cloudflare:test'
import { createLiveQueryCollection, eq, type Collection } from '@tanstack/db'
import type { SequencedBatch, WriteAck, WriteBatch } from '../../src/protocol.ts'
import { CLOSE_IDENTITY_CHANGED } from '../../src/protocol.ts'
import { createPartyDb } from '../../src/client/party-db.ts'
import type { ResetReason, Transport } from '../../src/client/sync-client.ts'
import { ids as rowIds, partyUrl, roomHeader } from './helpers.ts'
import { notes, remarks } from './worker.ts'

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

// partysocket can't dial `SELF`, so this transport plays its part: it reads the
// client's cursor on every dial, redials after any close but its own hang-up
// unless `refuse` says the room won't take it back, and forwards frames only from
// its current socket, as PartySocket does once it disconnects one.
async function redialing(room: string, token: string) {
  let current = token
  let refuse = false
  let ws: WebSocket | undefined
  let closed = false
  let since: () => unknown = () => undefined
  let dialing: Promise<void> = Promise.resolve()
  const listeners = new Set<(batch: SequencedBatch) => void>()
  const openers = new Set<() => void>()
  const closers = new Set<(code: number) => void>()
  const dial = async () => {
    const cursor = since()
    const query: Record<string, string> = { token: current, ...(cursor === undefined ? {} : { since: String(cursor) }) }
    const res = await SELF.fetch(url(room, query), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
    const socket = res.webSocket!
    socket.accept()
    socket.addEventListener('message', (e) => {
      if (ws !== socket) return
      const batch = JSON.parse(e.data as string) as SequencedBatch
      for (const listener of listeners) listener(batch)
    })
    socket.addEventListener('close', (e) => {
      if (ws !== socket) return
      ws = undefined
      for (const listener of closers) listener(e.code)
      if (!closed && !refuse) dialing = dial()
    })
    ws = socket
    for (const listener of openers) listener()
  }
  await dial()
  const transport: Transport = {
    subscribe: (onBatch, opts) => ((since = opts?.since ?? since), listeners.add(onBatch), () => listeners.delete(onBatch)),
    async send(batches) {
      const res = await post(room, batches, current)
      if (!res.ok) throw new Error(`write rejected: ${res.status}`)
      return (await res.json()) as WriteAck
    },
    sendFrame: (frame) => ws?.send(JSON.stringify(frame)),
    isOpen: () => ws !== undefined,
    onOpen: (listener) => (openers.add(listener), () => openers.delete(listener)),
    onClose: (listener) => (closers.add(listener), () => closers.delete(listener)),
    reconnect() {
      const old = ws
      ws = undefined
      old?.close()
      dialing = dial()
    },
    close: () => ((closed = true), ws?.close()),
  }
  return { transport, as: (next: string) => void (current = next), refuse: () => void (refuse = true), dialed: () => dialing }
}

type Row = { id: string; thread_id?: string }
const thread = (collection: Collection<Row, string>) => createLiveQueryCollection((q) => q.from({ r: collection }).where(({ r }) => eq(r.thread_id, 'T')))

// alice and carol each own a note and a remark in thread T; carol starts as an editor
async function editorCarol(room: string) {
  const write = (channel: string, id: string): WriteBatch[] => [{ channel, ops: [{ type: 'insert', value: { id, text: id, ...(channel === 'remarks' ? { thread_id: 'T' } : {}) } }] }]
  for (const [channel, id, token] of [['notes', 'n-alice', 'alice'], ['notes', 'n-carol', 'carol:editor'], ['remarks', 'r-alice', 'alice'], ['remarks', 'r-carol', 'carol:editor']]) {
    expect((await post(room, write(channel, id), token)).status).toBe(200)
  }
  const carol = await redialing(room, 'carol:editor')
  const party = createPartyDb(carol.transport, [notes, remarks])
  const resets: ResetReason[] = []
  party.onReset((reason) => resets.push(reason))
  const oldThread = thread(party.db.remarks as never)
  await Promise.all([party.db.notes.preload(), oldThread.preload()])
  expect(rowIds(party.db.notes)).toEqual(['n-alice', 'n-carol'])
  expect(rowIds(oldThread)).toEqual(['r-alice', 'r-carol'])
  return { carol, party, resets, oldThread }
}

describe('a reset after an identity change, on a real room', () => {
  it("reloads every collection under the new identity when the room closes the socket (4001)", async () => {
    const room = 'roles-reset-4001'
    const { carol, party, resets, oldThread } = await editorCarol(room)

    carol.as('carol') // the host takes away her editor role
    expect((await SELF.fetch(url(room, { reconnect: 'carol' }), { headers: roomHeader(room) })).status).toBe(200)
    await vi.waitFor(() => expect(resets).toEqual(['identity-changed']))
    expect(rowIds(oldThread)).toEqual([]) // a query nobody rebuilt shows empty

    await carol.dialed()
    const newThread = thread(party.db.remarks as never)
    await Promise.all([party.db.notes.preload(), newThread.preload()])
    await vi.waitFor(() => expect(rowIds(party.db.notes)).toEqual(['n-carol']))
    expect(rowIds(newThread)).toEqual(['r-carol'])
    party.close()
  })

  it('reloads every collection when the app resets after signing in someone else', async () => {
    const room = 'roles-reset-requested'
    const { carol, party, resets } = await editorCarol(room)

    carol.as('carol') // she signs in again without the role; the room sends nothing
    party.reset()
    expect(resets).toEqual(['requested'])
    await carol.dialed()
    const newThread = thread(party.db.remarks as never)
    await Promise.all([party.db.notes.preload(), newThread.preload()])
    await vi.waitFor(() => expect(rowIds(party.db.notes)).toEqual(['n-carol']))
    expect(rowIds(newThread)).toEqual(['r-carol'])
    party.close()
  })

  it('empties everything on the 4001 itself, so a redial the room refuses leaks nothing', async () => {
    const room = 'roles-reset-refused'
    const { carol, party, oldThread } = await editorCarol(room)
    const oldNotes = party.db.notes

    carol.refuse() // a deactivated user: the lobby turns the redial away
    expect((await SELF.fetch(url(room, { reconnect: 'carol' }), { headers: roomHeader(room) })).status).toBe(200)
    await vi.waitFor(() => expect(party.db.notes).not.toBe(oldNotes))
    expect(rowIds(oldNotes)).toEqual([])
    expect(rowIds(oldThread)).toEqual([])
    party.close()
  })
})
