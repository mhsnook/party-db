import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import type { WriteAck, WriteReject } from '../../src/protocol.ts'
import { connect, insert, partyUrl, post, roomHeader } from './helpers.ts'

// Drive the real worker over HTTP + WS. Each test uses a distinct room so its
// Durable Object starts empty. `connect`/`post` live in ./helpers.ts.
const url = (room: string, since?: number) =>
  partyUrl('main', room, since === undefined ? {} : { since: String(since) })

describe('round-trip: insert → ack → broadcast → resolved row', () => {
  it('acks with the resolved row and fans it out to connected + fresh clients', async () => {
    const room = 'round-trip'
    const a = await connect(room)
    await a.waitFor(1) // snapshot (empty + ready)
    expect(a.batches[0]).toMatchObject({ channel: 'todos', ops: [], ready: true })

    // client omits `done`/`rev`; the DB defaults fill them in
    const res = await post(room, insert('t1', 'hello'))
    expect(res.status).toBe(200)
    const ack = (await res.json()) as WriteAck
    expect(ack.accepted).toEqual([{ channel: 'todos', seq: 1 }])
    // the ack carries the RESOLVED row (defaults applied), not just what was sent
    expect(ack.changed?.[0].ops[0].value).toEqual({ id: 't1', text: 'hello', done: false, rev: 1 })

    // the connected client receives the same resolved row on the stream
    await a.waitFor(2)
    expect(a.batches[1]).toMatchObject({ seq: 1, ops: [{ value: { id: 't1', done: false, rev: 1 } }] })

    // a client that connects AFTER the write sees it in its snapshot
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

describe('reconnect delta replays exactly the gap', () => {
  it('?since=N returns only batches after N, not a full snapshot', async () => {
    const room = 'delta'
    await post(room, insert('a', 'one')) // seq 1
    await post(room, insert('b', 'two')) // seq 2

    // a client that already applied up to seq 1 reconnects
    const c = await connect(room, 1)
    await c.waitFor(1)
    expect(c.batches.map((b) => b.seq)).toEqual([2]) // just the gap
    expect(c.batches[0].ops[0].value).toMatchObject({ id: 'b', text: 'two' })
    // a delta is not a snapshot: no `ready` sentinel
    expect(c.batches[0].ready).toBeUndefined()
    c.ws.close()
  })
})

describe('broadcast order == seq order', () => {
  it('delivers concurrent writes to a subscriber in seq order', async () => {
    const room = 'order'
    const sub = await connect(room)
    await sub.waitFor(1) // snapshot

    // fire three writes without awaiting between them; the DO serializes them
    await Promise.all([
      post(room, insert('x', '1')),
      post(room, insert('y', '2')),
      post(room, insert('z', '3')),
    ])

    await sub.waitFor(4) // snapshot + 3 broadcasts
    const seqs = sub.batches.slice(1).map((b) => b.seq)
    expect(seqs).toEqual([...seqs].sort((p, q) => Number(p) - Number(q))) // monotonic
    expect(new Set(seqs)).toEqual(new Set([1, 2, 3])) // each exactly once
    sub.ws.close()
  })
})

describe('the POST envelope reports the database verdict', () => {
  it('rejects an unknown channel with 400', async () => {
    const res = await post('reject-channel', [{ channel: 'nope', ops: [] }])
    expect(res.status).toBe(400)
    const body = (await res.json()) as WriteReject
    expect(body.error).toMatch(/unknown channel/)
    expect(body.channel).toBe('nope')
  })

  it('rejects a constraint violation (duplicate PK) with 409', async () => {
    const room = 'reject-constraint'
    expect((await post(room, insert('dup', 'first'))).status).toBe(200)
    const res = await post(room, insert('dup', 'second'))
    expect(res.status).toBe(409)
    const body = (await res.json()) as WriteReject
    expect(body.error).toBeTruthy()
    expect(body.constraint).toMatch(/todos/) // best-effort constraint context
  })

  it('rejects a malformed (non-array) body with 400', async () => {
    const res = await post('reject-body', { not: 'an array' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as WriteReject).error).toMatch(/WriteBatch/)
  })

  it('404s a non-POST request', async () => {
    const res = await SELF.fetch(url('reject-method'), { method: 'PUT', headers: roomHeader('reject-method') })
    expect(res.status).toBe(404)
  })
})
