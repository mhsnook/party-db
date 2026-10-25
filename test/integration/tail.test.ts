// A collection declared `snapshot: false` (architecture §8), end to end in
// workerd against the `Tailed` party. The room keeps the table and the `_oplog`
// exactly as for any collection; what changes is the connect: no rows, only the
// ready marker at the room's seq. So a fresh client tails from now, a brief
// disconnect heals as a `?since` delta, and a cursor past retention restarts
// the feed empty rather than serving a gappy one.

import { describe, it, expect, vi } from 'vitest'
import { SELF } from 'cloudflare:test'
import type { SequencedBatch, WriteAck, WriteBatch } from '../../src/protocol.ts'
import { partyUrl, roomHeader } from './helpers.ts'

const RETENTION = 50 // Tailed inherits Main's oplogRetention

const url = (room: string, since?: number) => partyUrl('tailed', room, since === undefined ? {} : { since: String(since) })

const event = (id: string, kind: string): WriteBatch[] => [{ channel: 'events', ops: [{ type: 'insert', value: { id, kind } }] }]
const recent = (id: string): WriteBatch[] => [{ channel: 'recent', ops: [{ type: 'insert', value: { id } }] }]
const todo = (id: string, text: string): WriteBatch[] => [{ channel: 'todos', ops: [{ type: 'insert', value: { id, text } }] }]

async function post(room: string, body: unknown): Promise<WriteAck> {
  const res = await SELF.fetch(url(room), { method: 'POST', headers: { 'content-type': 'application/json', ...roomHeader(room) }, body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  return (await res.json()) as WriteAck
}

async function connect(room: string, since?: number) {
  const res = await SELF.fetch(url(room, since), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const batches: SequencedBatch[] = []
  ws.addEventListener('message', (e) => batches.push(JSON.parse(e.data as string)))
  const waitFor = (n: number) => vi.waitFor(() => expect(batches.length).toBeGreaterThanOrEqual(n))
  const channel = (name: string) => batches.filter((b) => b.channel === name)
  return { ws, batches, waitFor, channel }
}

const ids = (batches: SequencedBatch[]) => batches.flatMap((b) => b.ops.map((op) => (op.value as { id: string }).id))

describe('a `snapshot: false` collection tails from the moment it connects', () => {
  it('connect sends it empty but ready at the room seq, while the other channel snapshots in full', async () => {
    const room = 'tail-connect'
    await post(room, event('e1', 'join')) // seq 1
    await post(room, todo('t1', 'one')) // seq 2

    const c = await connect(room)
    await c.waitFor(3)
    expect(c.channel('events')).toEqual([{ channel: 'events', seq: 2, ops: [], ready: true, reset: true }])
    expect(c.channel('recent')).toEqual([{ channel: 'recent', seq: 2, ops: [], ready: true, reset: true }])
    expect(ids(c.channel('todos'))).toEqual(['t1'])

    // live from here: the next event streams in like any fan-out
    await post(room, event('e2', 'leave'))
    await c.waitFor(4)
    expect(ids(c.channel('events'))).toEqual(['e2'])
    c.ws.close()
  })

  it('a reconnect inside retention is a delta: the feed heals, nothing is re-sent', async () => {
    const room = 'tail-reconnect'
    const c = await connect(room)
    await c.waitFor(3)
    const cursor = Number(c.channel('events')[0].seq) // 0 on an empty room
    c.ws.close()

    // missed while away
    await post(room, event('e1', 'join'))
    await post(room, event('e2', 'leave'))

    const again = await connect(room, cursor)
    await again.waitFor(2)
    expect(again.batches.every((b) => !b.reset)).toBe(true) // a delta, not a snapshot
    expect(ids(again.channel('events'))).toEqual(['e1', 'e2'])
    again.ws.close()
  })

  it('a cursor past retention restarts the feed empty — never a gappy one', async () => {
    const room = 'tail-stale'
    for (let i = 1; i <= RETENTION + 10; i++) await post(room, event(`e${i}`, 'tick'))

    const c = await connect(room, 1) // seq 1 is compacted away
    await c.waitFor(3)
    const feed = c.channel('events')
    expect(feed).toHaveLength(1)
    expect(feed[0]).toMatchObject({ reset: true, ready: true, ops: [], seq: RETENTION + 10 })
    c.ws.close()
  })

  it('the re-register frame gets the same empty reply', async () => {
    const room = 'tail-re-register'
    await post(room, event('e1', 'join'))
    const c = await connect(room)
    await c.waitFor(3)

    c.ws.send(JSON.stringify({ snapshot: 'events' }))
    await c.waitFor(4)
    expect(c.channel('events').at(-1)).toEqual({ channel: 'events', seq: 1, ops: [], ready: true, reset: true })
    c.ws.close()
  })
})

describe('a `snapshot: { last: n }` collection opens on its recent activity', () => {
  it('connect sends the rows the newest n batches left behind, then tails', async () => {
    const room = 'recent-connect'
    for (const id of ['r1', 'r2', 'r3']) await post(room, recent(id))
    await post(room, event('e1', 'join')) // another channel's batch does not count

    const c = await connect(room)
    await c.waitFor(3)
    const feed = c.channel('recent')
    expect(feed).toHaveLength(1)
    expect(feed[0]).toMatchObject({ seq: 4, ready: true, reset: true })
    expect(ids(feed)).toEqual(['r2', 'r3'])

    await post(room, recent('r4'))
    await c.waitFor(4)
    expect(ids(c.channel('recent'))).toEqual(['r2', 'r3', 'r4'])
    c.ws.close()
  })

  it('the re-register frame replays the same recent window', async () => {
    const room = 'recent-re-register'
    for (const id of ['r1', 'r2', 'r3']) await post(room, recent(id))
    const c = await connect(room)
    await c.waitFor(3)

    c.ws.send(JSON.stringify({ snapshot: 'recent' }))
    await c.waitFor(4)
    expect(ids([c.channel('recent').at(-1)!])).toEqual(['r2', 'r3'])
    c.ws.close()
  })
})
