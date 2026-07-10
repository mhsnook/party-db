// The seam between the transport (onRequest / onConnect) and the storage target.
//
// `onRequest` calls `write` blind to what's underneath: the schema-agnostic blob
// store (v0), structured SQL against your real tables (v1), or D1 later. That's
// the win — going v0 → v1 → D1 is "swap the adapter," not "rewrite onRequest."
//
// The contract is async on purpose. Embedded DO-SQLite is synchronous, but D1 is
// not (its atomic commit is `batch()`), so the interface is async and the DO
// serializes its write → seq → broadcast section (see PartyDbServer) to keep the
// ordering total even when the apply itself awaits.

import type { SequencedBatch, WriteBatch, WriteReject } from '../protocol.ts'

export interface PersistenceAdapter {
  // ensure our own infrastructure exists (the _oplog; the blob tables we own for
  // schema-less collections). It does NOT create your tables.
  init(): void | Promise<void>

  // Apply the WHOLE POST body in one transaction — all batches, all-or-nothing,
  // in the order given (the database judges; we don't re-derive ordering). Each
  // returned batch carries its assigned `seq` and its ops REPLACED by the
  // resolved rows the database actually committed (defaults, generated columns,
  // serials, same-row trigger effects).
  write(batches: WriteBatch[]): Promise<SequencedBatch[]>

  // Full current state per collection + the latest seq, for a fresh connection.
  snapshot(): Promise<SequencedBatch[]>

  // The delta a reconnecting client missed — oplog entries after `since`, in
  // order. Returns `null` when `since` predates what's still retained (compacted
  // away), so the caller must send a fresh snapshot instead of a gappy delta. An
  // empty array is a complete delta (the client missed nothing).
  replaySince(since: number): Promise<SequencedBatch[] | null>

  // Optional: turn a `write()` failure into the client-facing rejection (→ 409),
  // or return `null` to let the server treat it as an internal fault (→ 500). Each
  // engine knows how it phrases a constraint violation — Postgres has a structured
  // SQLSTATE + constraint name, strictly better than a message regex — so
  // classification belongs with the dialect. Adapters that omit this fall back to
  // the server's built-in SQLite-message classifier (embedded + D1).
  classifyError?(e: unknown): WriteReject | null
}
