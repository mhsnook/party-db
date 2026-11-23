import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import type { SequencedBatch, WriteBatch } from '../../src/protocol.ts'
import { CLOSE_IDENTITY_CHANGED } from '../../src/protocol.ts'
import { partyUrl, roomHeader } from './helpers.ts'

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
