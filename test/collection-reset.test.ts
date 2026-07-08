import { describe, it, expect } from 'vitest'
import { createCollection } from '@tanstack/db'
import { applyBatch, type ChannelSink } from '../src/client/apply.ts'
import type { SequencedBatch, WriteEvent } from '../src/protocol.ts'

// Grounds the reset/truncate contract against a REAL TanStack DB collection, not a
// recorder mock (apply.test.ts asserts call order; this asserts the actual effect).
// The whole feature rests on one claim — "applying a reset snapshot through our
// apply loop clears the collection and reloads it without a duplicate-key throw" —
// and only a real collection can falsify it.

type Todo = { id: string; text: string }

const ins = (id: string, text: string): WriteEvent => ({ type: 'insert', value: { id, text } })
const snapshot = (seq: number, ops: WriteEvent[]): SequencedBatch => ({
  channel: 'todos',
  seq,
  ops,
  reset: true,
  ready: true,
})

// A real collection wired the way the client wires it, exposing the actual sink
// TanStack hands to sync.sync (begin/write/commit/markReady/truncate).
function realCollection() {
  let sink: ChannelSink | undefined
  const collection = createCollection<Todo>({
    getKey: (t) => t.id,
    sync: { sync: (params) => void (sink = params as unknown as ChannelSink) },
  })
  const ready = collection.preload() // startSync runs sync.sync synchronously, capturing the sink
  return { collection, sink: sink!, ready }
}

describe('a reset snapshot replaces collection state (real TanStack collection)', () => {
  it('reloads the room and drops rows gone from the snapshot, with no duplicate-key throw', async () => {
    const { collection, sink, ready } = realCollection()

    applyBatch(sink, snapshot(1, [ins('a', 'aaa'), ins('b', 'bbb')]))
    await ready
    expect(new Set(collection.state.keys())).toEqual(new Set(['a', 'b']))

    // a re-snapshot after 'a' was deleted server-side, 'b' edited, and 'c' added.
    // 'b' is present in BOTH snapshots with a NEW value — re-applying it only lands
    // because the truncate cleared 'b' first; a plain append would collide on the
    // held key (TanStack's DuplicateKeySyncError). So this asserts the truncate is
    // load-bearing, not just that the rows arrive.
    applyBatch(sink, snapshot(9, [ins('b', 'bbb-v2'), ins('c', 'ccc')]))
    expect(new Set(collection.state.keys())).toEqual(new Set(['b', 'c'])) // 'a' gone, no throw
    expect(collection.get('b')).toMatchObject({ id: 'b', text: 'bbb-v2' }) // replaced, not stale
    expect(collection.get('c')).toMatchObject({ id: 'c', text: 'ccc' })
  })
})
