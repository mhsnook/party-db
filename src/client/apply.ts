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

import type { SequencedBatch, WriteEvent } from '../protocol.ts'

// The four callbacks a single collection exposes to the apply loop. On the client
// these are exactly TanStack DB's sync({ begin, write, commit, markReady }).
export type ChannelSink = {
  begin: () => void
  write: (op: WriteEvent) => void
  commit: () => void
  markReady: () => void
  // clear the collection before applying. TanStack DB's own sync param; called
  // only for `reset` batches, and only inside a begin/commit window.
  truncate: () => void
}

// Apply one ordered batch to one channel's sink. begin/commit bracket the batch so
// a multi-op batch (add a post AND tag it) lands atomically. A `reset` batch
// replaces rather than appends: it truncates first, in the same window, so the
// clear and the reload land in one commit (docs/architecture.md §8).
export function applyBatch(sink: ChannelSink, batch: SequencedBatch) {
  // a zero-op reset still opens the window — an emptied room must clear too;
  // a non-reset empty batch stays a no-op.
  if (batch.reset || batch.ops.length) {
    sink.begin()
    if (batch.reset) sink.truncate()
    for (const op of batch.ops) sink.write(op)
    sink.commit()
  }
  if (batch.ready) sink.markReady()
}
