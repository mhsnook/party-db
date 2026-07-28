// The Postgres adapter, end-to-end through the real (miniflare) worker: the full
// HTTP + WebSocket path against the `PgRoom` party, whose persistence is a
// `PgAdapter` over a real Postgres reached with `pg` over cloudflare:sockets (data
// AND _oplog both in PG). Mirrors the D1 suite — the point is that `?since` deltas,
// snapshots, atomicity and broadcast order behave IDENTICALLY to the other modes,
// now against a real Postgres from inside a Durable Object. Skips when PG_URL is
// unset, like every PG lane.
//
// "One room per Postgres database": every PgRoom shares the one PG_URL, so — unlike
// the DO-SQLite parties a distinct room name isolates — the tables are reset
// between tests via a direct connection. Each test then uses a single room starting
// from a clean, seq-1 database (the room's fresh DO recreates `todos` in onStart and
// `_oplog` in adapter.init on its first request).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import type { SequencedBatch, WriteAck, WriteBatch, WriteReject } from '../../src/protocol.ts'
import { partyUrl, roomHeader } from './helpers.ts'

const PG_URL = (env as { PG_URL?: string }).PG_URL

// The PgRoom party — partyserver kebab-cases the binding (`PgRoom` → `pg-room`) —
// with an optional `?since` cursor. Each test uses a distinct room.
const url = (room: string, since?: number) =>
  partyUrl('pg-room', room, since === undefined ? {} : { since: String(since) })

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

describe.skipIf(!PG_URL)('Postgres adapter, end-to-end through a Durable Object', () => {
  // a direct PG connection the test uses to reset tables + count rows, the way the
  // D1 suite uses env.DB (the adapter shares this same database from inside the DO).
  let pgClient: { query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> }

  beforeAll(async () => {
    const { default: pg } = await import('pg')
    const c = new pg.Client({ connectionString: PG_URL })
    await c.connect()
    pgClient = c as any
  })
  afterAll(async () => {
    await pgClient?.query('DROP TABLE IF EXISTS todos, docs, _oplog')
    // best-effort: release + drop the RLS-subject role the RLS suite created.
    await pgClient
      ?.query(`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='party_rls') THEN EXECUTE 'DROP OWNED BY party_rls'; DROP ROLE party_rls; END IF; END $$`)
      .catch(() => {})
    await pgClient?.end()
  })
  beforeEach(async () => {
    // every RLS test below uses a fresh room name (→ fresh DO → onStart rebuilds
    // docs + policy + role), so a clean-slate drop here is race-free (files in this
    // lane run sequentially within one file).
    await pgClient.query('DROP TABLE IF EXISTS todos, docs, _oplog')
  })

  const countOf = async (table: string) => {
    try {
      return Number((await pgClient.query(`SELECT count(*)::int AS c FROM ${table}`)).rows[0].c)
    } catch {
      return 0 // table not yet created (before the room's first request)
    }
  }

  it('round-trip: insert → ack with resolved row (PG defaults) → broadcast → fresh-client snapshot', async () => {
    const room = 'pg-round-trip'
    const a = await connect(room)
    await a.waitFor(1)
    expect(a.batches[0]).toMatchObject({ channel: 'todos', ops: [], ready: true })

    // client omits done/rev; the PG table defaults fill them, resolved from RETURNING.
    const res = await post(room, insert('t1', 'hello'))
    expect(res.status).toBe(200)
    const ack = (await res.json()) as WriteAck
    expect(ack.accepted).toEqual([{ channel: 'todos', seq: 1 }])
    expect(ack.changed?.[0].ops[0].value).toEqual({ id: 't1', text: 'hello', done: false, rev: 1 })

    await a.waitFor(2)
    expect(a.batches[1]).toMatchObject({ seq: 1, ops: [{ value: { id: 't1', done: false, rev: 1 } }] })

    // a client connecting AFTER the write sees it in its PG snapshot
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

  it('atomicity: a two-batch POST whose second batch collides → 409, no rows and no _oplog entries', async () => {
    const room = 'pg-atomic'
    // seed a row to collide with, in its own committed POST (seq 1)
    expect((await post(room, insert('dup', 'first'))).status).toBe(200)
    expect(await countOf('_oplog')).toBe(1)

    // one POST, two batches: the second re-inserts the taken PK → the whole write
    // rolls back, data AND log.
    const res = await post(room, [
      { channel: 'todos', ops: [{ type: 'insert', value: { id: 'ok', text: 'valid' } }] },
      { channel: 'todos', ops: [{ type: 'insert', value: { id: 'dup', text: 'again' } }] },
    ])
    expect(res.status).toBe(409)
    const body = (await res.json()) as WriteReject
    // the classifier surfaced the PG constraint's real name (SQLSTATE-derived)
    expect(body.constraint).toBe('todos_pkey')

    // 'ok' never landed; only the seed remains; the _oplog did not grow
    expect(await countOf('todos')).toBe(1)
    expect(await countOf('_oplog')).toBe(1)
  })

  it('reconnect delta: ?since=N returns only batches after N, resolved rows intact', async () => {
    const room = 'pg-delta'
    await post(room, insert('a', 'one')) // seq 1
    await post(room, insert('b', 'two')) // seq 2

    const c = await connect(room, 1)
    await c.waitFor(1)
    expect(c.batches.map((b) => b.seq)).toEqual([2]) // just the gap
    expect(c.batches[0].ops[0].value).toEqual({ id: 'b', text: 'two', done: false, rev: 1 })
    expect(c.batches[0].ready).toBeUndefined() // a delta is not a snapshot
    c.ws.close()
  })

  it('stale cursor past the compaction floor → reset snapshot', async () => {
    const room = 'pg-stale'
    const RETENTION = 50 // PgRoom.oplogRetention
    const total = RETENTION + 10 // 60 writes → after compaction the floor sits above seq 1
    for (let i = 1; i <= total; i++) expect((await post(room, insert(`r${i}`, `row ${i}`))).status).toBe(200)

    const c = await connect(room, 1) // seq 1 fell out of the retained window
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

  it('broadcast order == seq order under concurrent POSTs (serialize queue, real awaits)', async () => {
    const room = 'pg-order'
    const sub = await connect(room)
    await sub.waitFor(1)

    // fire several writes without awaiting between them; the DO serializes the
    // write → seq → broadcast section even though each apply now awaits Postgres.
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

// Postgres-native RLS, proven END TO END through a Durable Object: the identity
// the `auth` hook resolves per POST is injected into the write transaction, and
// the app's own RLS policies decide the outcome — a forged write comes back 403 AT
// THE WIRE, not 200 and not 500. The adapter-level enforcement is pinned in the
// node lane (test/pg/pg-rls.test.ts); this proves the server threads identity and
// maps the RLS denial to the right HTTP status. Shares this file (not a new one) so
// all PG-touching integration stays in one sequentially-run file — the rooms share
// the one Postgres and its `_oplog`. Skips when PG_URL is unset.
describe.skipIf(!PG_URL)('Postgres RLS end-to-end (PgRlsRoom: SET LOCAL role + claims)', () => {
  // POST to the RLS room, optionally as a user (Bearer token IS the user id here).
  const rlsUrl = (room: string) => partyUrl('pg-rls-room', room, {})
  async function rlsPost(room: string, body: unknown, token?: string): Promise<Response> {
    return SELF.fetch(rlsUrl(room), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...roomHeader(room),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  }
  const doc = (id: string, body: string, owner?: string): WriteBatch[] => [
    { channel: 'docs', ops: [{ type: 'insert', value: owner === undefined ? { id, body } : { id, owner, body } }] },
  ]

  it('authorized write commits (200) and the owner is stamped from the verified claim', async () => {
    const res = await rlsPost('rls-ok', doc('d1', 'hi'), 'alice') // owner omitted → defaulted from claim
    expect(res.status).toBe(200)
    const ack = (await res.json()) as WriteAck
    expect(ack.changed?.[0].ops[0].value).toEqual({ id: 'd1', owner: 'alice', body: 'hi' })
  })

  it('a forged owner id is refused by the database and surfaces as 403 at the wire', async () => {
    const res = await rlsPost('rls-forge', doc('d2', 'forge', 'bob'), 'alice') // alice claims bob's id
    expect(res.status).toBe(403)
    const body = (await res.json()) as WriteReject
    expect(body.error).toMatch(/row-level security/i)
  })

  it('an anonymous write runs as the anonRole (party_rls) — RLS-subject, so it is refused → 403, not bypassed', async () => {
    // no Bearer → auth returns null → `anonRole` downgrades the (superuser)
    // connection to party_rls before the write, so RLS still governs it. Without
    // that downgrade a superuser connection would write straight through.
    const res = await rlsPost('rls-anon', doc('d3', 'x', 'anyone'))
    expect(res.status).toBe(403)
  })
})
