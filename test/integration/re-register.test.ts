// The re-register path, end to end in workerd (issue #47). TanStack DB cleans a
// collection up when its last subscriber leaves and restarts sync on the next
// access; the restarted collection is EMPTY, and nothing replays it. So the
// client sends the one up-frame — `{ snapshot: <channel> }` — and the room
// answers that connection with a `reset` snapshot.
//
// Two levels here, because the bug and the invariant live at different ones:
// a real TanStack collection over a real Durable Object (rows come back,
// `isReady` fires again), and the raw socket (a concurrent write can't interleave
// with the re-snapshot).

import { SELF } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createPartyDb } from '../../src/client/party-db.ts'
import { definePartyCollection } from '../../src/schema.ts'
import type { Transport } from '../../src/client/sync-client.ts'
import type { SequencedBatch, WriteAck } from '../../src/protocol.ts'
import { insert, partyUrl, post, roomHeader } from './helpers.ts'

// the same collection `Main` (worker.ts) serves, declared as an app declares it
const todos = definePartyCollection({
  name: 'todos',
  key: 'id',
  schema: z.object({ id: z.string(), text: z.string(), done: z.boolean().optional(), rev: z.number().optional() }),
})

// A `Transport` over the test worker: partysocket can't dial `SELF`, so the
// down-stream is the raw WebSocket this opens and the up-path is the same POST
// helper the rest of the suite uses. Everything above it — SyncClient, the
// collection, `persist` — is the real client.
async function workerTransport(room: string) {
  const res = await SELF.fetch(partyUrl('main', room), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const listeners = new Set<(batch: SequencedBatch) => void>()
  const requested: string[] = []
  ws.addEventListener('message', (e) => {
    const batch = JSON.parse(e.data as string) as SequencedBatch
    for (const listener of listeners) listener(batch)
  })
  const transport: Transport = {
    subscribe(onBatch) {
      listeners.add(onBatch)
      return () => listeners.delete(onBatch)
    },
    async send(batches) {
      const res = await post(room, batches)
      if (!res.ok) throw new Error(`write rejected: ${res.status}`)
      return (await res.json()) as WriteAck
    },
    requestSnapshot(channel) {
      requested.push(channel)
      ws.send(JSON.stringify({ snapshot: channel }))
    },
  }
  return { transport, ws, requested }
}

const ids = (collection: { toArray: { id: string }[] }) => collection.toArray.map((row) => row.id).sort()

describe('a collection that re-registers after cleanup gets a fresh snapshot', () => {
  it('refills the restarted collection and fires isReady again', async () => {
    const room = 're-register'
    await post(room, insert('t1', 'one'))

    const { transport, ws, requested } = await workerTransport(room)
    const { db } = createPartyDb(transport, [todos])
    const collection = db.todos

    await collection.preload()
    expect(collection.isReady()).toBe(true)
    expect(ids(collection)).toEqual(['t1'])
    expect(requested).toEqual([]) // the connect snapshot filled it; nothing was asked for

    // exactly what TanStack does when the last subscriber leaves past gcTime
    await collection.cleanup()
    expect(collection.isReady()).toBe(false)
    expect(ids(collection)).toEqual([])

    // a write while nothing is registered: the re-snapshot must carry it too
    await post(room, insert('t2', 'two'))

    // reopening the panel: sync restarts, so `register` runs a second time
    void collection.preload()
    await vi.waitFor(() => expect(collection.isReady()).toBe(true))
    expect(ids(collection)).toEqual(['t1', 't2'])
    expect(requested).toEqual(['todos']) // one request, for the one channel

    // and the collection is live again — a later write streams in as before
    await post(room, insert('t3', 'three'))
    await vi.waitFor(() => expect(ids(collection)).toEqual(['t1', 't2', 't3']))

    ws.close()
  })
})

describe('the re-snapshot is serialized against concurrent writes', () => {
  it('delivers the write once, in seq order, on the requesting connection', async () => {
    const room = 're-register-race'
    await post(room, insert('r1', 'one'))

    const res = await SELF.fetch(partyUrl('main', room), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    ws.accept()
    const frames: SequencedBatch[] = []
    ws.addEventListener('message', (e) => void frames.push(JSON.parse(e.data as string)))
    await vi.waitFor(() => expect(frames).toHaveLength(1)) // the connect snapshot

    // ask for a re-snapshot and write in the same tick — the room's queue decides
    // the order, and both outcomes are correct as long as they don't interleave.
    ws.send(JSON.stringify({ snapshot: 'todos' }))
    const ack = (await (await post(room, insert('r2', 'two'))).json()) as WriteAck
    const writeSeq = Number(ack.accepted[0].seq)

    await vi.waitFor(() => expect(frames).toHaveLength(3)) // + the re-snapshot + the fan-out
    const seqs = frames.map((f) => Number(f.seq))
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

    // the committed write reached this connection exactly once
    const fanout = frames.filter((f) => !f.reset && Number(f.seq) === writeSeq)
    expect(fanout).toHaveLength(1)
    expect(fanout[0].ops[0].value).toMatchObject({ id: 'r2' })

    // and the re-snapshot is a consistent cut: its rows are the state at its seq,
    // never a mix of before and after the concurrent commit
    const snapshot = frames.filter((f) => f.reset).at(-1)!
    const rows = snapshot.ops.map((op) => (op.value as { id: string }).id).sort()
    expect(rows).toEqual(Number(snapshot.seq) < writeSeq ? ['r1'] : ['r1', 'r2'])

    ws.close()
  })

  it('drops a request for a channel the room does not serve', async () => {
    const room = 're-register-unknown'
    const res = await SELF.fetch(partyUrl('main', room), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
    const ws = res.webSocket!
    ws.accept()
    const frames: SequencedBatch[] = []
    ws.addEventListener('message', (e) => void frames.push(JSON.parse(e.data as string)))
    await vi.waitFor(() => expect(frames).toHaveLength(1)) // the connect snapshot

    ws.send(JSON.stringify({ snapshot: 'nope' }))
    ws.send('not a party-db frame at all')

    // the room stays up and keeps serving: the next write still fans out, and the
    // dropped frames added nothing before it
    await post(room, insert('u1', 'one'))
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(frames[1].ops[0].value).toMatchObject({ id: 'u1' })

    ws.close()
  })
})
