// The D1 persistence adapter — the second v1 storage target. Everything lives in
// the user's D1: their tables AND our `_oplog`, so the log commits atomically with
// the data it indexes and the two can never diverge.
//
// The one structural difference from the embedded adapter is why `statements.ts`
// exists: D1 has NO interactive transaction. Its only atomic unit is `batch()`, a
// statement list built entirely up front — you cannot read a RETURNING row, decode
// it in JS, and then INSERT the resolved-op JSON, because those would be separate
// statements outside any transaction. So the whole POST becomes ONE `batch()`:
//   batch₁ CRUD…, batch₁ oplog INSERT, batch₂ CRUD…, batch₂ oplog INSERT, …, compaction
// and the oplog INSERT assembles its resolved-op JSON *in SQL* (`resolvedOpJsonExpr`),
// reading back the rows the earlier statements in the same batch just wrote. The
// data, the log, and the AUTOINCREMENT seqs commit together or not at all — nothing
// can tear, and `?since` deltas behave identically to embedded.
//
// D1 is structured-only: the modes are a ratchet (uncontrolled → DO-SQLite → D1 →
// Postgres) and uncontrolled/blob mode stays an embedded-DO story. A collection
// with no readable schema on a D1 room is a configuration error at init(), not a
// blob table in someone's production database.

import type { SequencedBatch, WriteBatch } from '../protocol.ts'
import type { PartyCollection } from '../schema.ts'
import type { PersistenceAdapter } from './persistence.ts'
import { decodeRow } from './columns.ts'
import { buildPlans, oplogInsertStmt, resolveStructured, structuredStmt, type Plan, type StructuredPlan } from './statements.ts'

export type D1AdapterOptions = {
  // keep at most this many _oplog rows; older entries are compacted away after each
  // write (same meaning as the embedded adapter). Undefined / 0 → unbounded.
  oplogRetention?: number
}

export class D1Adapter implements PersistenceAdapter {
  private plans: Map<string, Plan>
  private retention: number

  constructor(
    private d1: D1Database,
    collections: PartyCollection<any>[],
    opts: D1AdapterOptions = {},
  ) {
    this.retention = opts.oplogRetention && opts.oplogRetention > 0 ? Math.floor(opts.oplogRetention) : 0
    this.plans = buildPlans(collections)
  }

  // Only the `_oplog` is ours to create — the one table the library adds to the
  // user's D1, beside their data. Their structured tables are theirs; we never DDL
  // them. A blob (schema-less) plan is rejected here: uncontrolled mode is
  // embedded-only. DDL runs as a single-line statement because d1.exec splits its
  // input on newlines.
  async init(): Promise<void> {
    for (const plan of this.plans.values()) {
      if (plan.kind === 'blob') {
        throw new Error(
          `collection "${plan.name}" has no readable schema: uncontrolled (blob) mode is embedded-only and not supported on D1 — declare a schema`,
        )
      }
    }
    await this.d1.exec(`CREATE TABLE IF NOT EXISTS _oplog (seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, ops TEXT NOT NULL)`)
  }

  async write(batches: WriteBatch[]): Promise<SequencedBatch[]> {
    if (!batches.length) return []

    // Build the whole POST as one statement list: each channel-batch's CRUD
    // statements, then its oplog INSERT (which reads those rows back into resolved
    // JSON in SQL), then one compaction DELETE. We remember where each batch's CRUD
    // results and its oplog result land so we can map them back after commit.
    const stmts: D1PreparedStatement[] = []
    const layout: { channel: string; plan: StructuredPlan; batch: WriteBatch; crudStart: number; oplogAt: number }[] = []

    for (const batch of batches) {
      const plan = this.plans.get(batch.channel)
      if (!plan) throw new Error(`unknown channel: ${batch.channel}`)
      // init() guarantees structured; guard the type and the (unreachable) blob case.
      if (plan.kind !== 'structured') throw new Error(`channel ${batch.channel} is not structured`)

      const crudStart = stmts.length
      for (const op of batch.ops) {
        const { sql, binds } = structuredStmt(plan, op)
        stmts.push(this.d1.prepare(sql).bind(...binds))
      }
      const oplog = oplogInsertStmt(batch.channel, batch.ops, plan)
      const oplogAt = stmts.length
      stmts.push(this.d1.prepare(oplog.sql).bind(...oplog.binds))
      layout.push({ channel: batch.channel, plan, batch, crudStart, oplogAt })
    }

    if (this.retention) {
      stmts.push(
        this.d1.prepare(`DELETE FROM _oplog WHERE seq <= (SELECT MAX(seq) FROM _oplog) - ?`).bind(this.retention),
      )
    }

    // one atomic commit for the entire POST — data, log, seqs. A constraint
    // rejection rolls the lot back (verified in the integration suite: the _oplog
    // gains no entries either).
    const results = await this.d1.batch<Record<string, unknown>>(stmts)

    return layout.map(({ channel, plan, batch, crudStart, oplogAt }) => {
      // each op's resolved value comes from its CRUD statement's RETURNING rows —
      // read the results array (never a single-row assumption): a delete and an
      // update-of-a-missing-row return no rows and fall back to the sent value.
      const ops = batch.ops.map((op, i) => resolveStructured(plan, op, results[crudStart + i].results))
      const seq = Number((results[oplogAt].results[0] as { seq: number }).seq)
      return { channel, ops, seq }
    })
  }

  async snapshot(): Promise<SequencedBatch[]> {
    // one read batch() — D1 runs it transactionally, so the watermark and every
    // table are a single consistent cut. `ready`/`reset` mirror the embedded
    // adapter: a fresh connection's snapshot replaces each channel.
    const structured = [...this.plans.values()].filter((p): p is StructuredPlan => p.kind === 'structured')
    const results = await this.d1.batch<Record<string, unknown>>([
      this.d1.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM _oplog`),
      ...structured.map((p) => this.d1.prepare(`SELECT * FROM "${p.name}"`)),
    ])
    const seq = Number((results[0].results[0] as { s: number }).s)
    return structured.map((plan, i) => {
      const rows = results[i + 1].results.map((r) => decodeRow(r, plan.kinds))
      return { channel: plan.name, seq, ops: rows.map((value) => ({ type: 'insert', value })), ready: true, reset: true }
    })
  }

  async replaySince(since: number): Promise<SequencedBatch[] | null> {
    // same two-query shape as the embedded adapter, over D1. min > 0 means we've
    // compacted everything below it; if the client's next-needed seq (since+1) has
    // been pruned, return null so the caller sends a fresh snapshot, not a gappy
    // delta. An empty array is a complete delta.
    const minRes = await this.d1.prepare(`SELECT MIN(seq) AS m FROM _oplog`).all<{ m: number | null }>()
    const min = Number(minRes.results[0]?.m ?? 0)
    if (min > 0 && since + 1 < min) return null
    const res = await this.d1
      .prepare(`SELECT seq, channel, ops FROM _oplog WHERE seq > ? ORDER BY seq`)
      .bind(since)
      .all<{ seq: number; channel: string; ops: string }>()
    return res.results.map((r) => ({ channel: r.channel, seq: Number(r.seq), ops: JSON.parse(r.ops) }))
  }
}
