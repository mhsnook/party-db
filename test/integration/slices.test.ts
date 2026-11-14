// Read slicing end to end in workerd (docs/architecture.md §18): a real
// PartyDbServer room, real sockets, and the real client — a TanStack live query
// whose `where` is the subscription.

import { describe, it, expect, vi } from 'vitest'
import { SELF } from 'cloudflare:test'
import { createLiveQueryCollection, eq, type Collection } from '@tanstack/db'
import { createPartyDb } from '../../src/client/party-db.ts'
import type { Transport } from '../../src/client/sync-client.ts'
import type { SequencedBatch, UpFrame, WriteAck, WriteBatch } from '../../src/protocol.ts'
import { comments } from './worker.ts'
import { partyUrl, roomHeader } from './helpers.ts'

const post = (room: string, body: WriteBatch[]) =>
  SELF.fetch(partyUrl('threads', room), { method: 'POST', headers: { 'content-type': 'application/json', ...roomHeader(room) }, body: JSON.stringify(body) })

const comment = (id: string, thread_id: string, body = id): WriteBatch[] => [
  { channel: 'comments', ops: [{ type: 'insert', value: { id, thread_id, body } }] },
]

async function socket(room: string) {
  const res = await SELF.fetch(partyUrl('threads', room), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const batches: SequencedBatch[] = []
  ws.addEventListener('message', (e) => batches.push(JSON.parse(e.data as string)))
  const send = (frame: UpFrame) => ws.send(JSON.stringify(frame))
  const comments = () => batches.filter((b) => b.channel === 'comments').flatMap((b) => b.ops.map((op) => op.value.id))
  return { ws, batches, send, comments }
}

// The real client over a raw test socket: partysocket can't dial `SELF`.
async function client(room: string) {
  const s = await socket(room)
  const sent: UpFrame[] = []
  const listeners = new Set<(batch: SequencedBatch) => void>()
  s.ws.addEventListener('message', (e) => {
    for (const listener of listeners) listener(JSON.parse(e.data as string))
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
    sendFrame: (frame) => {
      sent.push(frame)
      s.ws.send(JSON.stringify(frame))
    },
  }
  return { ...s, sent, ...createPartyDb(transport, [comments]) }
}

type Comment = { id: string; thread_id: string; body: string }

const thread = (db: Record<string, Collection<any>>, id: string) =>
  createLiveQueryCollection((q) => q.from({ c: db.comments as Collection<Comment> }).where(({ c }) => eq(c.thread_id, id)))

const ids = (collection: { toArray: ReadonlyArray<{ id: string }> }) => collection.toArray.map((row) => row.id).sort()

describe('a sliced collection over a real room', () => {
  it('sends a write only to the sockets watching its thread', async () => {
    const room = 'slices-routing'
    const a = await socket(room)
    const b = await socket(room)
    a.send({ subscribe: 'comments', slice: 'A' })
    b.send({ subscribe: 'comments', slice: 'B' })
    await vi.waitFor(() => expect(a.batches.some((x) => x.ready && x.slice === 'A')).toBe(true))
    await vi.waitFor(() => expect(b.batches.some((x) => x.ready && x.slice === 'B')).toBe(true))

    expect((await post(room, comment('c1', 'A'))).status).toBe(200)
    expect((await post(room, comment('c2', 'B'))).status).toBe(200)
    await vi.waitFor(() => expect(a.comments()).toEqual(['c1']))
    await vi.waitFor(() => expect(b.comments()).toEqual(['c2']))
    a.ws.close()
    b.ws.close()
  })

  it('loads the thread a live query asks for, and nothing else', async () => {
    const room = 'slices-live-query'
    await post(room, comment('a1', 'A'))
    await post(room, comment('b1', 'B'))
    const c = await client(room)

    const threadA = thread(c.db, 'A')
    await threadA.preload()
    expect(ids(threadA)).toEqual(['a1'])
    expect(c.db.comments!.has('b1')).toBe(false)

    await post(room, comment('a2', 'A'))
    await post(room, comment('b2', 'B'))
    await vi.waitFor(() => expect(ids(threadA)).toEqual(['a1', 'a2']))
    expect(c.db.comments!.has('b2')).toBe(false)
    c.close()
  })

  it('settles a write into the thread the writer is watching', async () => {
    const room = 'slices-write'
    const c = await client(room)
    const threadA = thread(c.db, 'A')
    await threadA.preload()

    const tx = c.db.comments!.insert({ id: 'mine', thread_id: 'A', body: 'hello' })
    await tx.isPersisted.promise
    expect(c.db.comments!.get('mine')).toMatchObject({ body: 'hello', $synced: true })
    c.close()
  })

  it('catches a reopened thread up with only what it missed', async () => {
    const room = 'slices-reopen'
    await post(room, comment('a1', 'A'))
    const c = await client(room)

    const first = thread(c.db, 'A')
    await first.preload()
    expect(ids(first)).toEqual(['a1'])
    await first.cleanup()
    await vi.waitFor(() => expect(c.sent.at(-1)).toEqual({ unsubscribe: 'comments', slice: 'A' }))
    const dropSeq = c.batches.at(-1)!.seq

    // a write while nobody watches thread A: it must not stream to this socket
    await post(room, comment('a2', 'A'))
    await post(room, [{ channel: 'todos', ops: [{ type: 'insert', value: { id: 't', text: 'flush' } }] }])
    await vi.waitFor(() => expect(c.batches.at(-1)?.channel).toBe('todos'))
    expect(c.comments()).not.toContain('a2')

    const frames = c.batches.length
    const again = thread(c.db, 'A')
    await again.preload()
    expect(ids(again)).toEqual(['a1', 'a2'])
    expect(c.sent.at(-1)).toEqual({ subscribe: 'comments', slice: 'A', since: dropSeq })
    // the reply was the delta after the drop, not the whole thread again
    const reply = c.batches.slice(frames).filter((b) => b.channel === 'comments')
    expect(reply.some((b) => b.reset)).toBe(false)
    expect(reply.flatMap((b) => b.ops.map((op) => op.value.id))).toEqual(['a2'])
    c.close()
  })

  it('refuses a write that moves a comment to another thread', async () => {
    const room = 'slices-immutable'
    await post(room, comment('a1', 'A'))
    const res = await post(room, [{ channel: 'comments', ops: [{ type: 'update', value: { id: 'a1', thread_id: 'B' } }] }])
    expect(res.status).toBe(400)
  })
})
