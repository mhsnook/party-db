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
import { assertIdent, columnsOf, decodeRow, encode, type ColumnKind, type ColumnSpec } from './columns.ts'

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

type StructuredPlan = {
  kind: 'structured'
  name: string
  key: string
  cols: ColumnSpec[]
  kinds: Map<string, ColumnKind>
}
type BlobPlan = { kind: 'blob'; name: string; key: string }
type Plan = StructuredPlan | BlobPlan

export type SqliteAdapterOptions = {
  // keep at most this many _oplog rows; older entries are compacted away after
  // each write. Undefined / 0 → unbounded (the _oplog grows forever, v0 behavior).
  // A reconnecting client whose cursor predates the oldest retained seq gets a
  // fresh snapshot instead of a gappy delta (see replaySince).
  oplogRetention?: number
}

export class SqliteAdapter implements PersistenceAdapter {
  private plans = new Map<string, Plan>()
  private retention: number

  constructor(
    private engine: SqlEngine,
    collections: PartyCollection<any>[],
    opts: SqliteAdapterOptions = {},
  ) {
    this.retention = opts.oplogRetention && opts.oplogRetention > 0 ? Math.floor(opts.oplogRetention) : 0
    for (const c of collections) {
      const name = assertIdent(c.name)
      const key = assertIdent(c.key)
      const cols = columnsOf(c.schema)
      // a schema we can read → structured CRUD against your table; otherwise the
      // schema-agnostic blob store.
      this.plans.set(
        name,
        cols
          ? { kind: 'structured', name, key, cols, kinds: new Map(cols.map((c) => [c.name, c.kind])) }
          : { kind: 'blob', name, key },
      )
    }
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
  // return the sequenced batch. Caller owns the surrounding transaction.
  private applyOne(batch: WriteBatch): SequencedBatch {
    const plan = this.plans.get(batch.channel)
    if (!plan) throw new Error(`unknown channel: ${batch.channel}`)
    const resolved =
      plan.kind === 'structured'
        ? batch.ops.map((op) => this.applyStructured(plan, op))
        : batch.ops.map((op) => this.applyBlob(plan, op))
    const seq = Number(
      this.engine
        .exec(`INSERT INTO _oplog (channel, ops) VALUES (?, ?) RETURNING seq`, batch.channel, JSON.stringify(resolved))
        .one().seq,
    )
    return { channel: batch.channel, ops: resolved, seq }
  }

  // CRUD against your real columns. `insert`/`update`/`delete` are distinct
  // statements (not a blanket upsert) so the database's own constraints get to
  // accept or reject — a PK collision on insert SHOULD fail, and does.
  private applyStructured(plan: StructuredPlan, op: WriteEvent): WriteEvent {
    const row = op.value as Record<string, unknown>
    const table = plan.name

    if (op.type === 'delete') {
      this.engine.exec(`DELETE FROM "${table}" WHERE "${plan.key}" = ?`, encode(row[plan.key]))
      return { type: 'delete', value: row }
    }

    if (op.type === 'update') {
      // SET only the columns the client actually sent (from the allowlist, not
      // the payload keys), keyed by the PK. Untouched columns keep their value.
      const set = plan.cols.filter((c) => c.name !== plan.key && row[c.name] !== undefined)
      const result = set.length
        ? this.engine.exec(
            `UPDATE "${table}" SET ${set.map((c) => `"${c.name}" = ?`).join(', ')} WHERE "${plan.key}" = ? RETURNING *`,
            ...set.map((c) => encode(row[c.name])),
            encode(row[plan.key]),
          )
        : // a no-op update (only the key present): just read the current row back.
          this.engine.exec(`SELECT * FROM "${table}" WHERE "${plan.key}" = ?`, encode(row[plan.key]))
      // if the row didn't exist (UPDATE/SELECT matched nothing), fall back to the
      // sent value — the DB simply applied a no-op. This MUST read a possibly-empty
      // cursor via toArray(): the real DO cursor's one() THROWS on zero rows (only
      // the test shim tolerated it), which would turn a benign ghost-update into a
      // 409 that rolls back the client's whole transaction.
      const resolved = result.toArray()[0]
      return {
        type: 'update',
        value: resolved ? decodeRow(resolved, plan.kinds) : row,
        previousValue: op.previousValue,
      }
    }

    // insert: name only the columns present in the payload, so columns the client
    // omitted fall to the DB's defaults / serials — and RETURNING hands those back.
    const cols = plan.cols.filter((c) => row[c.name] !== undefined)
    const result = this.engine.exec(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c.name}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`,
      ...cols.map((c) => encode(row[c.name])),
    )
    return { type: 'insert', value: decodeRow(result.one(), plan.kinds) }
  }

  // v0 blob store: one JSON row per PK. The resolved row equals the sent row.
  private applyBlob(plan: BlobPlan, op: WriteEvent): WriteEvent {
    const row = op.value as Record<string, unknown>
    const key = String(row[plan.key])
    if (op.type === 'delete') {
      this.engine.exec(`DELETE FROM "${plan.name}" WHERE k = ?`, key)
    } else {
      this.engine.exec(
        `INSERT INTO "${plan.name}" (k, data) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data`,
        key,
        JSON.stringify(row),
      )
    }
    return op
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
        // `reset`: a snapshot is a full replacement of the channel, so the client
        // truncates before applying it (see applyBatch). `ready`: backlog fully sent.
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
