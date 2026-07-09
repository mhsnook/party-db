// The D1 adapter, end-to-end through the real (miniflare) worker: the full HTTP +
// WebSocket path against the `D1Room` party, whose persistence is a `D1Adapter`
// over the local `env.DB` (data AND _oplog both in D1). Mirrors the core
// sync.test / reconnect.test cases — the point is that `?since` deltas, snapshots,
// atomicity and broadcast order behave IDENTICALLY to the embedded adapter, now
// with a real network round-trip (async apply) in the middle.
//
// Per-test isolated storage (the pool's default) gives each test a fresh D1, so a
// single room per test starts empty — matching the "one room per D1 database"
// scope constraint.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import type { SequencedBatch, WriteAck, WriteBatch, WriteReject } from '../../src/protocol.ts'
import { partyUrl, roomHeader } from './helpers.ts'

// The scope constraint is "one room per D1 database": every D1Room shares the one
// bound `env.DB`, so — unlike the DO-SQLite parties, which a distinct room name
// isolates — the D1 tables must be reset between tests. Each test then uses a
// single room and starts from a clean, seq-1 database. The room's fresh DO
// recreates `todos` (onStart) and `_oplog` (adapter.init) on its first request.
beforeEach(async () => {
  await env.DB.exec(`DROP TABLE IF EXISTS todos`)
  await env.DB.exec(`DROP TABLE IF EXISTS _oplog`)
})

// The D1Room party — partyserver kebab-cases the binding name (`D1Room` →
// `d1-room`) — with an optional `?since` cursor. Each test uses a distinct room.
const url = (room: string, since?: number) =>
  partyUrl('d1-room', room, since === undefined ? {} : { since: String(since) })

const insert = (id: string, text: string): WriteBatch[] => [{ channel: 'todos', ops: [{ type: 'insert', value: { id, text } }] }]

async function post(room: string, body: unknown): Promise<Response> {
  return SELF.fetch(url(room), { method: 'POST', headers: { 'content-type': 'application/json', ...roomHeader(room) }, body: JSON.stringify(body) })
}

async function connect(room: string, since?: number) {
  const res = await SELF.fetch(url(room, since), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const batches: SequencedBatch[] = []
  ws.addEventListener('message', (e) => batches.push(JSON.parse(e.data as string)))
  const waitFor = (n: number) => vi.waitFor(() => expect(batches.length).toBeGreaterThanOrEqual(n))
  return { ws, batches, waitFor }
}

// Count rows directly in D1 — the adapter shares `env.DB` with the DO, so a
// single-room test's tables are fully visible here (used to prove atomic
// rollback). Tolerant of a not-yet-created table (returns 0 before the first
// request instantiates the room's DO).
const countOf = async (table: string) => {
  try {
    return Number((await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>())?.c ?? 0)
  } catch {
    return 0
  }
}
const oplogCount = () => countOf('_oplog')
const todoCount = () => countOf('todos')

describe('D1 round-trip: insert → ack → broadcast → resolved row', () => {
  it('acks with the resolved row (D1 defaults applied) and fans it out to connected + fresh clients', async () => {
    const room = 'd1-round-trip'
    const a = await connect(room)
    await a.waitFor(1)
    expect(a.batches[0]).toMatchObject({ channel: 'todos', ops: [], ready: true })

    // client omits done/rev; the D1 table defaults fill them, and the resolved row
    // is assembled straight from the RETURNING rows the batch() committed.
    const res = await post(room, insert('t1', 'hello'))
    expect(res.status).toBe(200)
    const ack = (await res.json()) as WriteAck
    expect(ack.accepted).toEqual([{ channel: 'todos', seq: 1 }])
    expect(ack.changed?.[0].ops[0].value).toEqual({ id: 't1', text: 'hello', done: false, rev: 1 })

    await a.waitFor(2)
    expect(a.batches[1]).toMatchObject({ seq: 1, ops: [{ value: { id: 't1', done: false, rev: 1 } }] })

    // a client connecting AFTER the write sees it in its D1 snapshot
    const b = await connect(room)
    await b.waitFor(1)
    expect(b.batches[0]).toMatchObject({
      ready: true,
      seq: 1,
      ops: [{ type: 'insert', value: { id: 't1', text: 'hello', done: false, rev: 1 } }],
    })

    a.ws.close()
    b.ws.close()
  })
})

describe('D1 atomicity: the oplog rolls back with the data', () => {
  it('a two-batch POST whose second batch collides → 409, no rows and no _oplog entries', async () => {
    const room = 'd1-atomic'
    expect(await oplogCount()).toBe(0)

    // seed a row to collide with, in its own committed POST (seq 1)
    expect((await post(room, insert('dup', 'first'))).status).toBe(200)
    expect(await oplogCount()).toBe(1)

    // one POST, two batches: the first would insert 'ok', the second re-inserts the
    // taken PK. The whole batch() must roll back — data AND log.
    const res = await post(room, [
      { channel: 'todos', ops: [{ type: 'insert', value: { id: 'ok', text: 'valid' } }] },
      { channel: 'todos', ops: [{ type: 'insert', value: { id: 'dup', text: 'again' } }] },
    ])
    expect(res.status).toBe(409)
    const body = (await res.json()) as WriteReject
    expect(body.error).toBeTruthy()
    expect(body.constraint).toMatch(/todos/)

    // 'ok' never landed; only the seed row remains; the _oplog did NOT grow
    expect(await todoCount()).toBe(1)
    expect(await oplogCount()).toBe(1) // the design's core claim: log rolled back with data

    // and the seq counter never advanced — the next successful write is seq 2, not 3
    const ok = (await post(room, insert('after', 'ok'))) as Response
    expect(((await ok.json()) as WriteAck).accepted).toEqual([{ channel: 'todos', seq: 2 }])
  })
})

describe('D1 reconnect delta replays exactly the gap', () => {
  it('?since=N returns only batches after N, with the resolved rows (oplog JSON round-trips)', async () => {
    const room = 'd1-delta'
    await post(room, insert('a', 'one')) // seq 1
    await post(room, insert('b', 'two')) // seq 2

    const c = await connect(room, 1)
    await c.waitFor(1)
    expect(c.batches.map((b) => b.seq)).toEqual([2]) // just the gap
    // the SQL-assembled oplog JSON round-trips the wire as the resolved row
    expect(c.batches[0].ops[0].value).toEqual({ id: 'b', text: 'two', done: false, rev: 1 })
    expect(c.batches[0].ready).toBeUndefined() // a delta is not a snapshot
    c.ws.close()
  })
})

describe('D1 stale cursor past the compaction floor → reset snapshot', () => {
  it('a ?since older than the retained window heals with a reset:true snapshot', async () => {
    const room = 'd1-stale'
    const RETENTION = 50 // D1Room.oplogRetention
    const total = RETENTION + 10 // 60 writes → after compaction the floor sits at seq 11
    for (let i = 1; i <= total; i++) expect((await post(room, insert(`r${i}`, `row ${i}`))).status).toBe(200)

    // seq 1 fell out of the retained window → onConnect must send a full snapshot
    const c = await connect(room, 1)
    await c.waitFor(1)
    const first = c.batches[0]
    expect(first.ready).toBe(true)
    expect(first.reset).toBe(true) // the heal marker
    expect(first.seq).toBe(total)
    expect(first.ops).toHaveLength(total)
    const ids = new Set(first.ops.map((op) => (op.value as { id: string }).id))
    expect(ids).toEqual(new Set(Array.from({ length: total }, (_, i) => `r${i + 1}`)))
    c.ws.close()
  })
})

describe('D1 broadcast order == seq order under concurrent POSTs', () => {
  it('delivers concurrent writes to a subscriber in seq order (the serialize queue, with real awaits)', async () => {
    const room = 'd1-order'
    const sub = await connect(room)
    await sub.waitFor(1)

    // fire several writes without awaiting between them; the DO serializes the
    // write → seq → broadcast section even though each apply now awaits D1.
    await Promise.all([
      post(room, insert('x', '1')),
      post(room, insert('y', '2')),
      post(room, insert('z', '3')),
      post(room, insert('w', '4')),
    ])

    await sub.waitFor(5) // snapshot + 4 broadcasts
    const seqs = sub.batches.slice(1).map((b) => Number(b.seq))
    expect(seqs).toEqual([...seqs].sort((p, q) => p - q)) // monotonic
    expect(new Set(seqs)).toEqual(new Set([1, 2, 3, 4])) // each exactly once
    sub.ws.close()
  })
})

describe('D1 update-of-a-missing-row (plan-002 parity + COALESCE fallback)', () => {
  it('200 no-op echoing the sent value, and the oplog entry carries the sent value', async () => {
    const room = 'd1-update-missing'
    const res = await post(room, [
      { channel: 'todos', ops: [{ type: 'update', value: { id: 'ghost', text: 'boo' }, previousValue: { id: 'ghost' } }] },
    ])
    expect(res.status).toBe(200)
    const ack = (await res.json()) as WriteAck
    // the resolved op echoes the sent value (no row to read back)
    expect(ack.changed?.[0].ops[0]).toMatchObject({ type: 'update', value: { id: 'ghost', text: 'boo' } })
    expect(await todoCount()).toBe(0) // nothing was created

    // a reconnecting client replays that op from the oplog — the COALESCE fallback
    // stored the sent value, not a null.
    const c = await connect(room, 0)
    await c.waitFor(1)
    expect(c.batches[0].ops[0]).toMatchObject({ type: 'update', value: { id: 'ghost', text: 'boo' }, previousValue: { id: 'ghost' } })
    c.ws.close()
  })
})
