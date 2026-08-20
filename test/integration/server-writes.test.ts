// Server-originated writes: rows the ROOM'S OWN host code commits, not a client
// POST (#41). The `Hosted` party (test/integration/worker.ts) stands in for that
// host code — a job or an agent running inside the Durable Object — and reaches
// the write → seq → broadcast section through `commit()`.
//
// What each case pins: a host write gets a seq and an `_oplog` entry, fans out to
// already-connected sockets, and shows up in a reconnect delta — the three things
// a raw `INSERT` into the table does NOT do (the last case proves the split
// `commit()` closes). Plus ordering against concurrent POSTs, and the throw a
// database rejection surfaces to host code.

import { describe, it, expect, vi } from 'vitest'
import { SELF } from 'cloudflare:test'
import type { SequencedBatch, WriteBatch } from '../../src/protocol.ts'
import { partyUrl, roomHeader } from './helpers.ts'

// The `Hosted` party, with an optional `?since` cursor. Each test uses a distinct
// room so its Durable Object starts empty.
const url = (room: string, query: Record<string, string> = {}) => partyUrl('hosted', room, query)

const insert = (id: string, text: string): WriteBatch[] => [{ channel: 'todos', ops: [{ type: 'insert', value: { id, text } }] }]

async function post(room: string, body: unknown): Promise<Response> {
  return SELF.fetch(url(room), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...roomHeader(room) },
    body: JSON.stringify(body),
  })
}

// Trigger the room's host code: `host` commits inline, `deferred` commits under
// waitUntil after answering, `raw` writes the table with its own SQL.
async function hostWrite(room: string, kind: 'host' | 'deferred' | 'raw', id: string): Promise<Response> {
  return SELF.fetch(url(room, { [kind]: id }), { headers: roomHeader(room) })
}

async function connect(room: string, since?: number) {
  const res = await SELF.fetch(url(room, since === undefined ? {} : { since: String(since) }), {
    headers: { Upgrade: 'websocket', ...roomHeader(room) },
  })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const batches: SequencedBatch[] = []
  ws.addEventListener('message', (e) => batches.push(JSON.parse(e.data as string)))
  const waitFor = (n: number) => vi.waitFor(() => expect(batches.length).toBeGreaterThanOrEqual(n))
  return { ws, batches, waitFor }
}

describe('commit(): a write the server authors', () => {
  it('assigns a seq, returns the resolved row, and fans out to a connected client', async () => {
    const room = 'host-inline'
    const a = await connect(room)
    await a.waitFor(1) // snapshot (empty + ready)

    const res = await hostWrite(room, 'host', 'h1')
    expect(res.status).toBe(200)
    const { sequenced } = (await res.json()) as { sequenced: SequencedBatch[] }
    // same shape a POST's ack carries: one seq per batch, ops replaced by the rows
    // the database committed (`done`/`rev` defaulted, never sent).
    expect(sequenced).toMatchObject([
      { channel: 'todos', seq: 1, ops: [{ type: 'insert', value: { id: 'h1', text: 'host h1', done: false, rev: 1 } }] },
    ])

    // the already-connected client gets it — the half a raw INSERT never reaches
    await a.waitFor(2)
    expect(a.batches[1]).toMatchObject({ channel: 'todos', seq: 1, ops: [{ value: { id: 'h1', done: false, rev: 1 } }] })
    a.ws.close()
  })

  it('lands in a reconnect delta, not only in the next snapshot', async () => {
    const room = 'host-delta'
    await post(room, insert('t1', 'from a client')) // seq 1
    await hostWrite(room, 'host', 'h2') // seq 2, authored by the server

    const c = await connect(room, 1)
    await c.waitFor(1)
    expect(c.batches.map((b) => b.seq)).toEqual([2]) // the host write is in the gap
    expect(c.batches[0].ops[0].value).toMatchObject({ id: 'h2', text: 'host h2' })
    c.ws.close()
  })

  it('reaches a connected client when the request returns first and the write settles later', async () => {
    const room = 'host-deferred'
    const a = await connect(room)
    await a.waitFor(1)

    // the shape the use case has: the handler answers, the work commits under
    // waitUntil after the response is already on the wire.
    const res = await hostWrite(room, 'deferred', 'h3')
    expect(res.status).toBe(202)

    await a.waitFor(2)
    expect(a.batches[1]).toMatchObject({ seq: 1, ops: [{ value: { id: 'h3', text: 'host h3' } }] })
    a.ws.close()
  })

  it('keeps broadcast order == seq order when host writes interleave with POSTs', async () => {
    const room = 'host-order'
    const a = await connect(room)
    await a.waitFor(1)

    // fired together: both paths go through the same serialize queue, so whatever
    // order the DO picks, the socket sees seqs ascending.
    await Promise.all([
      post(room, insert('c1', 'client one')),
      hostWrite(room, 'host', 'h4'),
      post(room, insert('c2', 'client two')),
      hostWrite(room, 'host', 'h5'),
    ])

    await a.waitFor(5)
    const seqs = a.batches.slice(1).map((b) => Number(b.seq))
    expect(seqs).toEqual([1, 2, 3, 4])
    // every row is there once, whatever the interleaving
    const ids = a.batches.slice(1).map((b) => b.ops[0].value.id)
    expect([...ids].sort()).toEqual(['c1', 'c2', 'h4', 'h5'])
    a.ws.close()
  })

  it('throws the database rejection to the caller and commits nothing', async () => {
    const room = 'host-reject'
    const a = await connect(room)
    await a.waitFor(1)
    expect((await hostWrite(room, 'host', 'dup')).status).toBe(200) // seq 1

    await a.waitFor(2)
    const res = await hostWrite(room, 'host', 'dup') // same primary key
    expect(res.status).toBe(500) // the test room's own reporting of the throw
    expect(((await res.json()) as { error: string }).error).toMatch(/constraint failed/i)

    // nothing new broadcast, nothing new sequenced: the rejected write rolled back
    const after = await connect(room)
    await after.waitFor(1)
    expect(after.batches[0].seq).toBe(1)
    expect(a.batches).toHaveLength(2)
    a.ws.close()
    after.ws.close()
  })

  it('a raw INSERT is the split commit() closes: snapshot only, never the stream', async () => {
    const room = 'host-raw'
    const a = await connect(room)
    await a.waitFor(1)

    expect((await hostWrite(room, 'raw', 'r1')).status).toBe(200)
    // give a broadcast a chance to arrive before asserting it never does
    await post(room, insert('t1', 'a normal write'))
    await a.waitFor(2)

    // the connected client saw the POST (seq 1) and NOT the raw row
    expect(a.batches.slice(1).map((b) => b.ops[0].value.id)).toEqual(['t1'])

    // nor is the raw row in the oplog, so no reconnect delta can ever carry it:
    // replaying from 0 returns the POST alone.
    const delta = await connect(room, 0)
    await delta.waitFor(1)
    expect(delta.batches.flatMap((b) => b.ops.map((o) => o.value.id))).toEqual(['t1'])

    // but a fresh client reads the real table, so it DOES see the raw row: two
    // clients on one room, diverged by connection history.
    const fresh = await connect(room)
    await fresh.waitFor(1)
    expect(fresh.batches[0].ops.map((o) => o.value.id).sort()).toEqual(['r1', 't1'])
    a.ws.close()
    delta.ws.close()
    fresh.ws.close()
  })
})
