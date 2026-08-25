// The composed host, end to end in workerd: `Composed` (worker.ts) is a plain
// partyserver `Server` — the stand-in for a host that already extends another
// `Server` and cannot subclass PartyDbServer — holding a `PartyDbCore`. The
// suite proves the held core serves the same round-trip a PartyDbServer room
// does (POST → ack → fan-out, `?since` replay), and that the host's own socket
// traffic stays off the party-db connections.

import { SELF } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { partyUrl, roomHeader, insert } from './helpers.ts'
import type { SequencedBatch, WriteAck } from '../../src/protocol.ts'

const url = (room: string, query: Record<string, string> = {}) => partyUrl('composed', room, query)

async function post(room: string, body: unknown): Promise<Response> {
  return SELF.fetch(url(room), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...roomHeader(room) },
    body: JSON.stringify(body),
  })
}

// Open a WebSocket to the composed room and collect every raw frame. The
// `query` decides which side of the host's routing this connection lands on:
// `{ proto: 'party-db' }` is a party-db subscriber, nothing is host traffic.
async function connect(room: string, query: Record<string, string> = {}) {
  const res = await SELF.fetch(url(room, query), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const frames: string[] = []
  ws.addEventListener('message', (e) => frames.push(e.data as string))
  const waitFor = (n: number) => vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(n))
  return { ws, frames, waitFor }
}

describe('a Server that holds the core instead of subclassing', () => {
  it('serves the party-db round-trip: POST → resolved ack → fan-out to the party-db connection', async () => {
    const room = 'composed-roundtrip'
    const sub = await connect(room, { proto: 'party-db' })
    await sub.waitFor(1) // the connect snapshot of the (empty) room

    const res = await post(room, insert('c1', 'via the held core'))
    expect(res.status).toBe(200)
    const ack = (await res.json()) as WriteAck
    // the resolved row carries the table defaults the client never sent
    expect(ack.changed![0].ops[0].value).toMatchObject({ id: 'c1', text: 'via the held core', done: false, rev: 1 })

    await sub.waitFor(2)
    const batch = JSON.parse(sub.frames[1]) as SequencedBatch
    expect(batch.seq).toBe(ack.accepted[0].seq)
    expect(batch.ops[0].value).toMatchObject({ id: 'c1', done: false, rev: 1 })
  })

  it("keeps the host's own connections off the party-db fan-out, and vice versa", async () => {
    const room = 'composed-routing'
    const own = await connect(room) // no marker → the host's own protocol
    const sub = await connect(room, { proto: 'party-db' })

    await own.waitFor(1)
    expect(own.frames).toEqual(['host: hello'])
    await sub.waitFor(1) // the connect snapshot of the (empty) room

    await post(room, insert('c2', 'routed'))
    await sub.waitFor(2)

    // the party-db subscriber got its snapshot + the sequenced batch — no
    // greeting; the host connection still holds only its greeting — no batch.
    expect(sub.frames).toHaveLength(2)
    expect((JSON.parse(sub.frames[1]) as SequencedBatch).ops[0].value).toMatchObject({ id: 'c2' })
    expect(own.frames).toEqual(['host: hello'])
  })

  it('replays a ?since delta through the composed connect path', async () => {
    const room = 'composed-replay'
    const first = (await (await post(room, insert('c3', 'one'))).json()) as WriteAck
    await post(room, insert('c4', 'two'))

    const behind = await connect(room, { proto: 'party-db', since: String(first.accepted[0].seq) })
    await behind.waitFor(1)
    expect(behind.frames).toHaveLength(1)
    expect((JSON.parse(behind.frames[0]) as SequencedBatch).ops[0].value).toMatchObject({ id: 'c4' })
  })
})
