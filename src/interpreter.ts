// The multiplexing interpreter. The whole point: client and server run the
// SAME function over the SAME wire format. "If it works in one place it'll work
// in the others, because it's the same thing." The server is just a little
// stricter because its sink is backed by real storage (SQLite / Postgres).

import type { SequencedBatch, WriteEvent } from './protocol.ts'

// The callbacks a single collection exposes to the interpreter.
//   - on the client these are TanStack DB's sync({ begin, write, commit, markReady })
//   - on the server they are the same four methods on its server-side collection
export type ChannelSink = {
  begin: () => void
  write: (op: WriteEvent) => void
  commit: () => void
  markReady: () => void
}

// Apply one ordered batch to one channel's sink. begin/commit bracket the batch
// so a multi-op batch (add a post AND tag it) lands atomically.
export function applyBatch(sink: ChannelSink, batch: SequencedBatch) {
  if (batch.ops.length) {
    sink.begin()
    for (const op of batch.ops) sink.write(op)
    sink.commit()
  }
  if (batch.ready) sink.markReady()
}
