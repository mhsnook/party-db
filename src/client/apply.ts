// The client's batch-apply helper. Given an ordered batch of WriteEvents, bracket
// them in one begin()/commit() window (so a multi-op batch lands atomically),
// replay each op, then signal markReady.
//
// This drives TanStack DB's own sync({ begin, write, commit, markReady }) — the
// client collection is the only sink. It is NOT a "both sides" interpreter: the
// server (SQLite) and any future target (Postgres) have their OWN apply, because
// their transaction boundary (the whole /write POST) and their seq assignment
// don't fit this per-batch shape. What's shared across targets is the WIRE TYPES
// (protocol.ts) and the apply CONTRACT ("atomic, in order") — not this loop.

import { sliceText, type SequencedBatch, type WriteEvent } from '../protocol.ts'

type Key = string | number

// The callbacks a single collection exposes to the apply loop. On the client
// these are exactly TanStack DB's sync({ begin, write, commit, markReady, truncate }).
export type ChannelSink = {
  begin: () => void
  write: (op: WriteEvent | { type: 'delete'; key: Key }) => void
  // TanStack returns a receipt: `true` once the writes are visible, or a promise
  // that resolves when they become visible (they wait for an in-flight optimistic
  // transaction to settle).
  commit: () => true | Promise<void> | void
  markReady: () => void
  // clear the collection before applying. TanStack DB's own sync param; called
  // only for `reset` batches, and only inside a begin/commit window.
  truncate: () => void
}

// How a sliced collection's batches apply (docs/architecture.md §18).
export type SliceApply = {
  column: string
  // the rows the collection holds now, to find the ones a slice snapshot replaces.
  rows: () => Iterable<[Key, object]>
  // false for a row in a slice this client is not subscribed to: the room may
  // send one (over-delivery is its safe failure), and we drop it.
  accepts: (row: Record<string, unknown>) => boolean
}

// Apply one ordered batch to one channel's sink. begin/commit bracket the batch so
// a multi-op batch (add a post AND tag it) lands atomically. A `reset` batch
// replaces rather than appends: it truncates first, in the same window, so the
// clear and the reload land in one commit (docs/architecture.md §8).
//
// On a sliced collection, a reset that names a `slice` replaces only that slice's
// rows, and every insert is written as an update: TanStack upserts an update to
// a missing key, so a row that arrives twice (a replay overlapping what a
// whole-channel subscription already sent) cannot throw a duplicate-key error.
export function applyBatch(sink: ChannelSink, batch: SequencedBatch, slicing?: SliceApply): true | Promise<void> {
  const ops = slicing ? batch.ops.filter((op) => slicing.accepts(op.value)) : batch.ops
  let receipt: true | Promise<void> = true
  // a zero-op reset still opens the window — an emptied room must clear too;
  // a non-reset empty batch stays a no-op.
  if (batch.reset || ops.length) {
    sink.begin()
    if (batch.reset && slicing && batch.slice !== undefined) {
      const text = sliceText(batch.slice)
      const stale = [...slicing.rows()].filter(([, row]) => sliceText((row as Record<string, unknown>)[slicing.column]) === text).map(([key]) => key)
      for (const key of stale) sink.write({ type: 'delete', key })
    } else if (batch.reset) {
      sink.truncate()
    }
    for (const op of ops) sink.write(slicing && op.type === 'insert' ? { ...op, type: 'update' } : op)
    const committed = sink.commit()
    if (committed instanceof Promise) receipt = committed
  }
  if (batch.ready) sink.markReady()
  return receipt
}
