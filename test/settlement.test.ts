import { describe, it, expect } from 'vitest'
import { createTransaction } from '@tanstack/db'
import { createPartyDb } from '../src/client/party-db.ts'
import { definePartyCollection } from '../src/schema.ts'
import type { Transport } from '../src/client/sync-client.ts'
import type { SequencedBatch, WriteAck, WriteBatch } from '../src/protocol.ts'

// The optimistic → synced handoff against a REAL TanStack collection. The promise
// under test is "the overlay drops onto the synced row without a flicker": from
// the moment the insert applies, the row never disappears, and it ends as the
// row the server resolved — not the one the client sent.

type Todo = { id: string; text: string; created_at?: string }

const todos = definePartyCollection<Todo, 'todos'>({ name: 'todos', key: 'id' })
const tags = definePartyCollection<{ id: string; todo_id: string }, 'tags'>({ name: 'tags', key: 'id' })

// A transport the test drives by hand: `send` acks with the next seq and parks
// the resolved batch; `deliver()` streams it down, as the room's fan-out would.
function scriptedTransport() {
  let onBatch: ((batch: SequencedBatch) => void) | undefined
  let seq = 9
  const parked: SequencedBatch[] = []
  const sent: WriteBatch[][] = []
  const transport: Transport = {
    subscribe(listener) {
      onBatch = listener
      return () => (onBatch = undefined)
    },
    async send(batches: WriteBatch[]): Promise<WriteAck> {
      sent.push(batches)
      const sequenced = batches.map((b) => ({
        channel: b.channel,
        seq: ++seq,
        ops: b.ops.map((op) => ({ ...op, value: { ...op.value, created_at: 'server-time' } })),
      }))
      parked.push(...sequenced)
      return { accepted: sequenced.map((b) => ({ channel: b.channel, seq: b.seq })) }
    },
  }
  return {
    transport,
    sent,
    push: (batch: SequencedBatch) => onBatch!(batch),
    deliver: () => {
      for (const batch of parked.splice(0)) onBatch!(batch)
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('settlement on a real TanStack collection', () => {
  it('keeps the row visible from the optimistic insert through to the resolved row', async () => {
    const { transport, push, deliver } = scriptedTransport()
    const { db } = createPartyDb(transport, [todos])
    const collection = db.todos
    const ready = collection.preload()
    push({ channel: 'todos', seq: 0, ops: [], reset: true, ready: true })
    await ready

    const events: string[] = []
    const sub = collection.subscribeChanges((changes) => {
      for (const c of changes) events.push(`${c.type}:${c.key}`)
    })

    const tx = collection.insert({ id: 'a', text: 'hello' })
    expect(collection.get('a')).toMatchObject({ text: 'hello' })

    // the ack has landed but the seq hasn't streamed back: the overlay holds.
    await tick()
    expect(tx.state).toBe('persisting')
    expect(collection.get('a')).toMatchObject({ text: 'hello', $synced: false })

    deliver()
    await tx.isPersisted.promise
    expect(tx.state).toBe('completed')
    expect(collection.get('a')).toMatchObject({ id: 'a', text: 'hello', created_at: 'server-time', $synced: true })
    // never removed, so never a gap a live query would render
    expect(events.filter((e) => e === 'delete:a')).toEqual([])
    sub.unsubscribe()
  })

  it('applies another writer’s row that streams in while this write is in flight', async () => {
    const { transport, push, deliver } = scriptedTransport()
    const { db } = createPartyDb(transport, [todos])
    const collection = db.todos
    const ready = collection.preload()
    push({ channel: 'todos', seq: 0, ops: [], reset: true, ready: true })
    await ready

    const tx = collection.insert({ id: 'mine', text: 'mine' })
    await tick()
    push({ channel: 'todos', seq: 5, ops: [{ type: 'insert', value: { id: 'theirs', text: 'theirs' } }] })
    deliver()
    await tx.isPersisted.promise
    expect(collection.get('theirs')).toMatchObject({ text: 'theirs' })
    expect(collection.get('mine')).toMatchObject({ text: 'mine' })
  })

  // docs/architecture.md §12: an explicit transaction bypasses the collection
  // handlers, so a cross-collection write is ONE POST, never one per collection.
  it('sends a cross-collection transaction as one POST', async () => {
    const { transport, sent, push, deliver } = scriptedTransport()
    const { db, persist } = createPartyDb(transport, [todos, tags])
    const ready = Promise.all([db.todos.preload(), db.tags.preload()])
    push({ channel: 'todos', seq: 0, ops: [], reset: true, ready: true })
    push({ channel: 'tags', seq: 0, ops: [], reset: true, ready: true })
    await ready

    const tx = createTransaction({ mutationFn: persist })
    tx.mutate(() => {
      db.todos.insert({ id: 't1', text: 'hello' })
      db.tags.insert({ id: 'g1', todo_id: 't1' })
    })
    await tick()
    deliver()
    await tx.isPersisted.promise
    expect(sent).toHaveLength(1)
    expect(sent[0]!.map((b) => b.channel)).toEqual(['todos', 'tags'])
  })
})
