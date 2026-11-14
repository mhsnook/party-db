// The wire contract. Deliberately tiny — this is the only thing that travels.
//
// A `WriteEvent` is *exactly* what TanStack DB's sync `write()` accepts
// (`Omit<ChangeMessage, 'key'>`): the collection derives the key from `value`
// via its own getKey, so we never put a key on the wire.

import type { ChangeMessage } from '@tanstack/db'

// One directive against one row. `T` mirrors `ChangeMessage`'s own `object`
// constraint — rows are records, never primitives.
export type WriteEvent<T extends object = Record<string, unknown>> = Omit<
  ChangeMessage<T>,
  'key'
>

// One begin()/commit() window for a single collection ("channel" === table name).
// Producers mint these; in trusting mode they are also what travels down.
export type WriteBatch<T extends object = Record<string, unknown>> = {
  channel: string
  ops: WriteEvent<T>[]
}

// The ordering token = the authority's OWN commit-log position. Opaque, but
// monotonically comparable within a channel.
//   - Durable Object: an integer (the _oplog AUTOINCREMENT rowid)
//   - Postgres: a WAL LSN (string)
// Hence not just `number`. See docs/unspecified.md → "seq is a commit-log cursor".
export type Cursor = number | string

// What a batch becomes once the authority has accepted + ordered it. The ops
// here are the *resolved* rows (post-commit: db defaults, generated columns),
// which is what every consumer applies.
export type SequencedBatch<T extends object = Record<string, unknown>> = WriteBatch<T> & {
  seq: Cursor
  // sentinel: this channel's backlog has been fully replayed to you.
  ready?: boolean
  // this batch replaces the channel rather than appending to it: the consumer
  // clears its state before applying (see docs/architecture.md §8).
  reset?: boolean
  // this batch answers a subscribe for this slice. With `reset`, it replaces only
  // the rows of that slice, never the whole channel (docs/architecture.md §18).
  slice?: SliceValue
}

// Reply to POST /write in controlled mode (the accept-and-ack).
// The ack's job is to hand back the match token so the caller's handler can
// await seq appearing on the down-stream (awaitTxId-style) and then resolve.
// The resolved data itself arrives via the stream like everyone else's, so
// `changed` is an OPTIONAL latency optimization (e.g. for a caller that holds
// no stream subscription).
export type WriteAck = {
  // the seq assigned to each accepted batch, in submit order
  accepted: { channel: string; seq: Cursor }[]
  // optional: resolved rows, when the caller wants them without waiting for the
  // stream. Empty when client-minted ids win and there are no generated cols.
  changed?: SequencedBatch[]
}

// Reply when the POST is rejected, so the mutating client gets the database's
// verdict — not a bare 500. `error` is always set; `channel`/`constraint`/`code`
// are best-effort context pulled from the failure. The client surfaces this and
// rolls its optimistic mutation back.
//
// `code` tells apart two verdicts that share a status: a 409 from a constraint, and
// a 409 from an update that matched no row (§16).
export type WriteReject = {
  error: string
  channel?: string
  constraint?: string
  code?: WriteRejectCode
}

export type WriteRejectCode = 'missing-row'

// The traffic marker: `partyTransport` puts `?proto=party-db` on every connect
// and every write POST. A host that serves other traffic on the same room routes
// party-db requests by it (`isPartyDbRequest`, docs/architecture.md §15); a
// `PartyDbServer` room ignores it. Fixed values — one room never speaks two
// party-db protocols, so there is nothing to configure.
export const PROTO_PARAM = 'proto'
export const PROTO_VALUE = 'party-db'

// Checks that a frame is our shape, because composed hosts may not filter
// dispatches cleanly.
export function isSequencedBatch(value: unknown): value is SequencedBatch {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Partial<SequencedBatch>
  return typeof frame.channel === 'string' && Array.isArray(frame.ops)
}

// One op's shape, checked at the edge before anything reads into it. The access
// gate and the statement builders both index `op.value` by column name, so a null
// or primitive value would throw out of them as a 500 rather than come back as the
// bad request it is. Lives here with the other wire guards, and is the ONE place
// that says what a writable op looks like — nothing downstream re-checks it.
export function isWritableOp(value: unknown): value is WriteEvent {
  if (typeof value !== 'object' || value === null) return false
  const { type, value: row } = value as { type?: unknown; value?: unknown }
  if (type !== 'insert' && type !== 'update' && type !== 'delete') return false
  return typeof row === 'object' && row !== null && !Array.isArray(row)
}

// A slice value: what a row's `sliceBy` column holds. Both sides compare slice
// values as text (`sliceText`), so a SERIAL thread id 7 matches a "7" from a URL.
export type SliceValue = string | number

export function sliceText(value: unknown): string {
  return String(value)
}

// The frames a client sends UP the socket. A subscribe asks the room to start
// sending one channel, or one slice of it, to this socket; the reply is ordinary
// batches for that channel, ending in one marked `ready` (and `slice`, when a
// slice was asked for).
//
// - No `slice`: the whole channel. For a channel without `sliceBy` this is the
//   re-register request (docs/architecture.md §8a), answered with a `reset` snapshot.
// - `since`: the client already holds this slice as of that seq, so the reply is
//   the delta after it. A cursor the room no longer retains gets a snapshot.
export type SubscribeFrame = {
  subscribe: string
  slice?: SliceValue
  since?: Cursor
}

// Stop sending this slice (or, with no `slice`, the whole-channel subscription)
// to this socket. A slice the socket never subscribed is dropped.
export type UnsubscribeFrame = {
  unsubscribe: string
  slice?: SliceValue
}

export type UpFrame = SubscribeFrame | UnsubscribeFrame

const isSliceValue = (v: unknown): v is SliceValue => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

// Same posture as `isSequencedBatch`: a host may share the socket, so prove the
// frame is ours before acting on it.
export function isUpFrame(value: unknown): value is UpFrame {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Record<string, unknown>
  if (frame.slice !== undefined && !isSliceValue(frame.slice)) return false
  if (typeof frame.subscribe === 'string') {
    return frame.since === undefined || typeof frame.since === 'number' || typeof frame.since === 'string'
  }
  return typeof frame.unsubscribe === 'string'
}

// Decode one socket frame of ours, or null when it isn't one. Both directions
// need this and for the same reason: a composed host shares the room's socket
// (docs/architecture.md §15), so the stream carries frames party-db did not send
// — binary, text that isn't JSON, JSON of another protocol. Pass the guard for
// the direction you're reading: `isSequencedBatch` coming down, `isUpFrame`
// going up.
export function parseFrame<T>(data: unknown, guard: (value: unknown) => value is T): T | null {
  if (typeof data !== 'string') return null
  try {
    const frame: unknown = JSON.parse(data)
    return guard(frame) ? frame : null
  } catch {
    return null
  }
}
