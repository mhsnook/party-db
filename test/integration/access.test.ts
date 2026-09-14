import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import type { SequencedBatch, WriteBatch } from '../../src/protocol.ts'
import { partyUrl, roomHeader } from './helpers.ts'

// Cookbook 5 at the wire, on a real DO: the `owned` party serves a public
// catalog (`phrases`) and per-user cards (`cards`, `ownerColumn: 'user_id'`). A
// socket's user is resolved once at connect and pinned to it as a tag; every
// frame asserted here is what actually crossed the WebSocket.

const url = (room: string, query: Record<string, string> = {}) => partyUrl('owned', room, query)

async function connect(room: string, token?: string, since?: number) {
  const query: Record<string, string> = { ...(token ? { token } : {}), ...(since !== undefined ? { since: String(since) } : {}) }
  const res = await SELF.fetch(url(room, query), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const frames: SequencedBatch[] = []
  ws.addEventListener('message', (e) => frames.push(JSON.parse(e.data as string)))
  return { ws, frames }
}

async function post(room: string, body: WriteBatch[], token?: string) {
  return SELF.fetch(url(room), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...roomHeader(room) },
    body: JSON.stringify(body),
  })
}

const card = (id: string, extra: Record<string, unknown> = {}): WriteBatch[] => [
  { channel: 'cards', ops: [{ type: 'insert', value: { id, status: 'learning', ...extra } }] },
]
const phrase = (id: string): WriteBatch[] => [{ channel: 'phrases', ops: [{ type: 'insert', value: { id, text: `phrase ${id}` } }] }]
const cardIds = (frames: SequencedBatch[]) =>
  frames.filter((f) => f.channel === 'cards').flatMap((f) => f.ops.map((op) => (op.value as { id: string }).id))
const live = (frames: SequencedBatch[]) => frames.filter((f) => !f.reset)
// the snapshot is two frames (one per collection); wait for it before writing.
const settled = (frames: SequencedBatch[]) => expect.poll(() => frames.filter((f) => f.reset).length).toBe(2)

describe('owned collections at the wire', () => {
  it("snapshots each socket with only its own user's cards, and the catalog for all", async () => {
    const room = 'owned-snapshot'
    expect((await post(room, card('a1'), 'alice')).status).toBe(200)
    expect((await post(room, card('b1'), 'bob')).status).toBe(200)
    expect((await post(room, phrase('p1'), 'alice')).status).toBe(200)
    const [alice, bob, anon] = [await connect(room, 'alice'), await connect(room, 'bob'), await connect(room)]
    for (const s of [alice, bob, anon]) await settled(s.frames)
    expect(cardIds(alice.frames)).toEqual(['a1'])
    expect(cardIds(bob.frames)).toEqual(['b1'])
    expect(cardIds(anon.frames)).toEqual([])
    for (const s of [alice, bob, anon]) {
      expect(s.frames.find((f) => f.channel === 'phrases')?.ops).toHaveLength(1)
      s.ws.close()
    }
  })

  it("fans a card out to its owner's sockets only, and a phrase to everyone", async () => {
    const room = 'owned-fanout'
    const [alice, bob, anon] = [await connect(room, 'alice'), await connect(room, 'bob'), await connect(room)]
    for (const s of [alice, bob, anon]) await settled(s.frames)
    expect((await post(room, card('a1'), 'alice')).status).toBe(200)
    expect((await post(room, phrase('p1'), 'bob')).status).toBe(200)
    // the phrase went out after the card, so once every socket has it, the card's
    // fan-out is over too: anything bob or anon were going to get, they have.
    for (const s of [alice, bob, anon]) await expect.poll(() => live(s.frames).some((f) => f.channel === 'phrases')).toBe(true)
    expect(cardIds(live(alice.frames))).toEqual(['a1'])
    expect(live(alice.frames).find((f) => f.channel === 'cards')?.ops[0].value).toMatchObject({ user_id: 'alice' })
    expect(cardIds(live(bob.frames))).toEqual([])
    expect(cardIds(live(anon.frames))).toEqual([])
    for (const s of [alice, bob, anon]) s.ws.close()
  })

  it('refuses an anonymous owner write 401, a forged owner 403, and a write to another user’s card 403', async () => {
    const room = 'owned-gate'
    expect((await post(room, card('b1'), 'bob')).status).toBe(200)
    expect((await post(room, card('x'))).status).toBe(401)
    expect((await post(room, card('x', { user_id: 'bob' }), 'alice')).status).toBe(403)
    const edit: WriteBatch[] = [{ channel: 'cards', ops: [{ type: 'update', value: { id: 'b1', status: 'known' } }] }]
    expect((await post(room, edit, 'alice')).status).toBe(403)
    const drop: WriteBatch[] = [{ channel: 'cards', ops: [{ type: 'delete', value: { id: 'b1' } }] }]
    expect((await post(room, drop, 'alice')).status).toBe(403)
    expect((await post(room, edit, 'bob')).status).toBe(200)
  })

  it("replays a reconnecting socket's delta with only its own user's cards", async () => {
    const room = 'owned-delta'
    await post(room, card('a1'), 'alice')
    await post(room, card('b1'), 'bob')
    await post(room, card('a2'), 'alice')
    const alice = await connect(room, 'alice', 0)
    await expect.poll(() => cardIds(alice.frames)).toEqual(['a1', 'a2'])
    expect(alice.frames.every((f) => !f.reset)).toBe(true)
    alice.ws.close()
  })
})
