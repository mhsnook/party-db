// The embedded DO-SQLite adapter. Persists into the structured tables YOU already
// built (CRUD against typed columns, capturing the resolved row via RETURNING),
// and keeps the schema-agnostic blob store for collections that ship no schema
// (v0's uncontrolled mode — opt out by omitting `schema`).
//
// What it owns vs. what it assumes:
//   - owns: the `_oplog` (ordering) and the `(k, data)` blob tables (no schema).
//   - assumes: your structured tables already exist with the columns + constraints
//     your app defined. We never DDL them — your database is the authority.
//
// Injection-safety is by construction: every value is bound with `?`, and every
// identifier (table + column names) comes from the schema/config allowlist —
// validated against an identifier regex — NEVER from the client payload's keys.

import type { SequencedBatch, WriteBatch, WriteEvent } from '../protocol.ts'
import type { PartyCollection } from '../schema.ts'
import type { PersistenceAdapter } from './persistence.ts'
import { decodeRow } from './columns.ts'
import { blobStmt, buildPlans, resolveStructured, structuredStmt, type Plan } from './statements.ts'

// The narrow slice of a SQLite handle the adapter needs. In the DO it's
// `ctx.storage.sql` + `ctx.storage.transactionSync`; in tests it's a node:sqlite
// shim. `exec` mirrors SqlStorage.exec (query + binds → cursor).
export interface SqlResult {
  toArray(): Record<string, unknown>[]
  one(): Record<string, unknown>
}
export interface SqlEngine {
  exec(query: string, ...bindings: unknown[]): SqlResult
  transaction<T>(fn: () => T): T
}

export type SqliteAdapterOptions = {
  // keep at most this many _oplog rows; older entries are compacted away after
  // each write. Undefined / 0 → unbounded (the _oplog grows forever, v0 behavior).
  // A reconnecting client whose cursor predates the oldest retained seq gets a
  // fresh snapshot instead of a gappy delta (see replaySince).
  oplogRetention?: number
}

export class SqliteAdapter implements PersistenceAdapter {
  private plans: Map<string, Plan>
  private retention: number

  constructor(
    private engine: SqlEngine,
    collections: PartyCollection<any>[],
    opts: SqliteAdapterOptions = {},
  ) {
    this.retention = opts.oplogRetention && opts.oplogRetention > 0 ? Math.floor(opts.oplogRetention) : 0
    // a schema we can read → structured CRUD against your table; otherwise the
    // schema-agnostic blob store (shared with the D1 adapter's plan builder).
    this.plans = buildPlans(collections)
  }

  init() {
    this.engine.exec(
      `CREATE TABLE IF NOT EXISTS _oplog (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         channel TEXT NOT NULL,
         ops TEXT NOT NULL
       )`,
    )
    // create only the tables WE own (the blob store). Structured tables are yours.
    for (const plan of this.plans.values()) {
      if (plan.kind === 'blob') {
        this.engine.exec(`CREATE TABLE IF NOT EXISTS "${plan.name}" (k TEXT PRIMARY KEY, data TEXT NOT NULL)`)
      }
    }
  }

  async write(batches: WriteBatch[]): Promise<SequencedBatch[]> {
    // one transaction over the whole POST: a cross-collection write is
    // all-or-nothing, and any constraint rejection rolls the lot back. Compaction
    // rides inside the same transaction so the oplog never has a torn floor.
    return this.engine.transaction(() => {
      const sequenced = batches.map((b) => this.applyOne(b))
      this.compact()
      return sequenced
    })
  }

  // Trim the _oplog to the most recent `retention` rows. AUTOINCREMENT means seqs
  // are never reused, so the remaining rows stay a contiguous suffix [min..max] —
  // which is what lets replaySince decide cleanly whether a delta is still whole.
  private compact() {
    if (!this.retention) return
    this.engine.exec(`DELETE FROM _oplog WHERE seq <= (SELECT MAX(seq) FROM _oplog) - ?`, this.retention)
  }

  // Apply one batch's ops to its table, write the resolved ops to the oplog, and
  // return the sequenced batch. Caller owns the surrounding transaction. The SQL
  // comes from the shared builders; the embedded adapter decodes the RETURNING row
  // in JS (its interactive transaction lets it), so it never needs the SQL-side
  // JSON builder the D1 adapter uses.
  private applyOne(batch: WriteBatch): SequencedBatch {
    const plan = this.plans.get(batch.channel)
    if (!plan) throw new Error(`unknown channel: ${batch.channel}`)
    const resolved = batch.ops.map((op) => this.applyOp(plan, op))
    const seq = Number(
      this.engine
        .exec(`INSERT INTO _oplog (channel, ops) VALUES (?, ?) RETURNING seq`, batch.channel, JSON.stringify(resolved))
        .one().seq,
    )
    return { channel: batch.channel, ops: resolved, seq }
  }

  // Run one op's shared CRUD statement and resolve it. Structured ops decode the
  // returned row (read via toArray(), which tolerates the empty result an
  // update-of-a-missing-row / delete yields); blob ops echo the sent value.
  private applyOp(plan: Plan, op: WriteEvent): WriteEvent {
    if (plan.kind === 'blob') {
      const { sql, binds } = blobStmt(plan, op)
      this.engine.exec(sql, ...binds)
      return op
    }
    const { sql, binds } = structuredStmt(plan, op)
    const rows = this.engine.exec(sql, ...binds).toArray()
    return resolveStructured(plan, op, rows)
  }

  async snapshot(): Promise<SequencedBatch[]> {
    // read the seq and every table inside one transaction so the snapshot is a
    // consistent cut: the rows are exactly the state as of `seq`, with no write
    // slipping in between reading the watermark and reading the rows. (Today the
    // DO is single-threaded so this is already true; the transaction locks it in
    // against a future refactor that adds an await mid-snapshot.)
    return this.engine.transaction(() => {
      const seq = Number(this.engine.exec(`SELECT COALESCE(MAX(seq), 0) AS s FROM _oplog`).one().s)
      const out: SequencedBatch[] = []
      for (const plan of this.plans.values()) {
        const rows =
          plan.kind === 'structured'
            ? this.engine.exec(`SELECT * FROM "${plan.name}"`).toArray().map((r) => decodeRow(r, plan.kinds))
            : this.engine.exec(`SELECT data FROM "${plan.name}"`).toArray().map((r) => JSON.parse(r.data as string))
        // `reset`: a snapshot replaces the channel (client truncates first);
        // `ready`: the backlog is fully sent. See docs/architecture.md §8.
        out.push({ channel: plan.name, seq, ops: rows.map((value) => ({ type: 'insert', value })), ready: true, reset: true })
      }
      return out
    })
  }

  // The delta a reconnecting client missed — oplog entries after `since`, in
  // order. Returns `null` when the cursor predates the oldest retained seq: after
  // compaction the entries in (since, min) are gone, so a delta would silently
  // drop rows; the caller must send a fresh snapshot instead. An empty array is a
  // real (complete) delta — the client missed nothing.
  async replaySince(since: number): Promise<SequencedBatch[] | null> {
    const min = Number(this.engine.exec(`SELECT MIN(seq) AS m FROM _oplog`).one().m ?? 0)
    // min > 0 means we've forgotten everything below `min`. The next seq the
    // client needs is since+1; if that's already been compacted away, fall back.
    if (min > 0 && since + 1 < min) return null
    return this.engine
      .exec(`SELECT seq, channel, ops FROM _oplog WHERE seq > ? ORDER BY seq`, since)
      .toArray()
      .map((r) => ({ channel: r.channel as string, seq: Number(r.seq), ops: JSON.parse(r.ops as string) }))
  }
}
