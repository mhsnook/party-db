// The wire contract. Deliberately tiny — this is the only thing that travels.
//
// A `WriteEvent` is *exactly* what TanStack DB's sync `write()` accepts
// (`Omit<ChangeMessage, 'key'>`): the collection derives the key from `value`
// via its own getKey, so we never put a key on the wire.

import type { ChangeMessage } from '@tanstack/db'

// One directive against one row.
export type WriteEvent<T = unknown> = Omit<ChangeMessage<T>, 'key'>

// One begin()/commit() window for a single collection ("channel" === table name).
// Producers mint these; in trusting mode they are also what travels down.
export type WriteBatch<T = unknown> = {
  channel: string
  ops: WriteEvent<T>[]
}

// What a batch becomes once the authority has accepted + ordered it.
// `seq` is per-channel (see unspecified.md → "Ordering").
export type SequencedBatch<T = unknown> = WriteBatch<T> & {
  seq: number
  // sentinel: this channel's backlog has been fully replayed to you.
  ready?: boolean
}

// Reply to POST /write in controlled mode (the accept-and-ack).
export type WriteAck = {
  // the seq assigned to each accepted batch, in submit order
  accepted: { channel: string; seq: number }[]
  // server-resolved values when they differ from what the client sent
  // (db defaults, server-assigned ids...). Empty when client-minted ids win.
  changed?: WriteBatch[]
}
