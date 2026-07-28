// The Postgres persistence adapter — mode 3, first rung. Same v1 contract as the
// embedded and D1 adapters: `/write` commits CRUD into the tables YOU already
// built, `RETURNING` captures the resolved rows, and our `_oplog` lives beside
// your data so the log commits atomically with what it indexes. `?since` deltas
// and reset snapshots behave identically to every other mode.
//
// Structurally this is the SMALLER port: Postgres has real interactive
// transactions, so the shape is the embedded adapter's — apply → decode → append
// log, all inside one BEGIN…COMMIT — with none of D1's assemble-the-JSON-in-SQL
// gymnastics (the resolved op is decoded in JS and inserted directly). The new
// work is only the dialect (`toPg` placeholders + the `pgEncode`/`pgDecode` codec)
// and the connection lifecycle from a Durable Object.
//
// What stays invisible until the WAL rung (docs/postgres-todo.md §§2–3): a change
// that never came through `/write` — a cron job, another service, a trigger's
// side-effects beyond RETURNING — does not sync live. That's the same caveat v1
// always carried, now against your company's own Postgres.
//
// Structured-only, one room per database, exactly as D1: a schema-less (blob)
// collection is a configuration error at init(), not a blob table in your
// production database.

import type { SequencedBatch, WriteBatch, WriteEvent } from '../protocol.ts'
import type { PartyCollection } from '../schema.ts'
import type { PersistenceAdapter, WriteIdentity, WriteRejection } from './persistence.ts'
import { pgDecodeRow, pgEncode } from './columns.ts'
import { buildPlans, resolveStructured, structuredStmt, toPg, type Plan, type StructuredPlan } from './statements.ts'

// The narrow slice of a node-postgres-style driver the adapter needs — `query(text,
// values) → { rows }`, the shape both `pg.Client` and a Hyperdrive-backed client
// expose. The library does NOT depend on `pg`: you construct the client (from a
// Hyperdrive binding or a connection string) and hand it in, so the driver stays
// yours to choose and pin. `end` is optional — used only to discard a connection
// that has gone bad so the next write reconnects.
export interface PgClient {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>
  end?(): Promise<void>
}

// A factory that opens (and connects) a fresh client. Called lazily on first use
// and again after a connection is discarded — never on a plain constraint
// rejection, which rolls back and keeps the connection. One in-flight transaction
// at a time is already guaranteed by PartyDbServer's serialize queue, so a single
// cached connection is all the adapter needs.
export type PgConnect = () => Promise<PgClient>

export type PgAdapterOptions = {
  // keep at most this many _oplog rows; older entries are compacted away after each
  // write (same meaning as the other adapters). Undefined / 0 → unbounded.
  oplogRetention?: number
}

export class PgAdapter implements PersistenceAdapter {
  private plans: Map<string, Plan>
  private retention: number
  private client: PgClient | null = null

  constructor(
    private connect: PgConnect,
    collections: PartyCollection<any>[],
    opts: PgAdapterOptions = {},
  ) {
    this.retention = opts.oplogRetention && opts.oplogRetention > 0 ? Math.floor(opts.oplogRetention) : 0
    this.plans = buildPlans(collections)
  }

  // Open the cached connection lazily; reuse it across calls (the server serializes
  // writes, so there's never more than one transaction on it at a time).
  private async conn(): Promise<PgClient> {
    if (!this.client) this.client = await this.connect()
    return this.client
  }

  // Discard a connection that has gone bad, so the next `conn()` reconnects. No
  // retry loop here: a failed POST fails, the client rolls its optimistic mutation
  // back and retries, and that retry gets a fresh connection.
  private async drop(): Promise<void> {
    const c = this.client
    this.client = null
    try {
      await c?.end?.()
    } catch {
      // best-effort: the connection is already being thrown away.
    }
  }

  // Only the `_oplog` is ours to create — the one library-owned table in your
  // database, beside your data. Your structured tables are yours; we never DDL
  // them. A blob (schema-less) plan is rejected here: uncontrolled mode is
  // embedded-only, same as D1.
  //
  // `seq BIGSERIAL`: Postgres sequences BURN numbers on rollback (and gaps can also
  // open under concurrency), so the retained window is NOT contiguous — gaps inside
  // it are normal and harmless. Nothing depends on contiguity: cursors only ever
  // come from delivered seqs, and `replaySince`'s floor check compares magnitudes,
  // never assumes a dense range. Do not "fix" the gaps. `ops JSONB` (not text): the
  // driver parses it back to a JS value on read, so `replaySince` needs no
  // JSON.parse.
  async init(): Promise<void> {
    for (const plan of this.plans.values()) {
      if (plan.kind === 'blob') {
        throw new Error(
          `collection "${plan.name}" has no readable schema: uncontrolled (blob) mode is embedded-only and not supported on Postgres — declare a schema`,
        )
      }
    }
    const c = await this.conn()
    await c.query(`CREATE TABLE IF NOT EXISTS _oplog (seq BIGSERIAL PRIMARY KEY, channel TEXT NOT NULL, ops JSONB NOT NULL)`)
  }

  async write(batches: WriteBatch[], identity?: WriteIdentity): Promise<SequencedBatch[]> {
    if (!batches.length) return []
    const c = await this.conn()
    try {
      // one transaction over the whole POST: a cross-collection write is
      // all-or-nothing, any constraint rejection rolls the lot back, and compaction
      // rides inside it so the oplog never has a torn floor. On a rollback the
      // BIGSERIAL still advances — the seq is burned, not emitted (verified).
      await c.query('BEGIN')
      // carry the verified identity into THIS transaction so the user's RLS
      // policies (and owner-column defaults) evaluate as that user. Transaction-
      // scoped, so it rides the existing shared connection with no per-user pool.
      await this.injectIdentity(c, identity)
      const sequenced: SequencedBatch[] = []
      for (const batch of batches) sequenced.push(await this.applyOne(c, batch))
      await this.compact(c)
      await c.query('COMMIT')
      return sequenced
    } catch (e) {
      // roll back so the connection is usable again. If ROLLBACK itself fails the
      // connection is gone — discard it so the next write reconnects. Either way the
      // original error propagates for the server to classify (constraint → 409).
      try {
        await c.query('ROLLBACK')
      } catch {
        await this.drop()
      }
      throw e
    }
  }

  // Set transaction-local settings in ONE round-trip via `set_config(name, value,
  // is_local => true)` — the FUNCTION form of `SET LOCAL`: transaction-scoped just
  // the same, but PARAMETERIZED, so every value is a bound value that can never
  // break out into SQL. (`SET LOCAL` itself takes no bind params; string-building it
  // would reopen the injection surface this feature exists to remove.) No-op when
  // there is nothing to set.
  private async setLocal(c: PgClient, settings: [name: string, value: string][]): Promise<void> {
    if (!settings.length) return
    const calls = settings.map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`).join(', ')
    await c.query(`SELECT ${calls}`, settings.flat())
  }

  // Inject the writer's verified identity into the current transaction, so RLS
  // policies and owner-column defaults see it — claims as the namespaced
  // `request.jwt.claims` (any role may set it) and/or the role to assume.
  //
  // The connection role MUST be RLS-subject — an ordinary role, or the table
  // owner under `FORCE ROW LEVEL SECURITY`. A superuser or `BYPASSRLS` role, or a
  // table owner without FORCE, skips every policy and this injection buys nothing.
  private async injectIdentity(c: PgClient, identity?: WriteIdentity): Promise<void> {
    if (!identity) return
    const settings: [string, string][] = []
    if (identity.claims) settings.push(['request.jwt.claims', JSON.stringify(identity.claims)])
    if (identity.role) settings.push(['role', identity.role])
    await this.setLocal(c, settings)
  }

  // Boot-time proof that the anonymous-write latch (`anonRole`) is real and safe,
  // so a misconfigured latch fails at startup, not on the first anonymous write.
  // Three checks, each with an actionable throw: the role EXISTS; it does NOT bypass
  // RLS (a superuser/`BYPASSRLS` anon role would let anonymous writes past every
  // policy — the exact thing the latch exists to prevent); and this connection can
  // actually ASSUME it (superuser, or a member — else the SET at write time would
  // 42501 every anonymous request).
  async verifyAnonRole(role: string): Promise<void> {
    const c = await this.conn()
    const { rows } = await c.query<{ bypass: boolean }>(
      `SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = $1`,
      [role],
    )
    if (!rows.length) throw new Error(`anonRole "${role}" does not exist — create it (CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS) or fix the name`)
    if (rows[0].bypass) {
      throw new Error(`anonRole "${role}" bypasses RLS (it is a superuser or has BYPASSRLS) — anonymous writes would not be governed by your policies; use an ordinary role`)
    }
    // Can this connection assume it? Test the exact SET the write path will do,
    // inside a throwaway transaction so nothing sticks.
    try {
      await c.query('BEGIN')
      await this.setLocal(c, [['role', role]])
      await c.query('COMMIT')
    } catch (e) {
      try {
        await c.query('ROLLBACK')
      } catch {
        await this.drop()
      }
      throw new Error(
        `the adapter's connection role cannot assume anonRole "${role}" — GRANT "${role}" TO the connection role, or connect as one that may SET ROLE "${role}" (${e instanceof Error ? e.message : String(e)})`,
      )
    }
  }

  // Apply one batch's ops to its table, append the resolved ops to the oplog, and
  // return the sequenced batch. Caller owns the surrounding transaction. Mirrors the
  // embedded adapter's applyOne: the interactive transaction lets us decode each
  // RETURNING row in JS and insert the resolved-op JSON directly.
  private async applyOne(c: PgClient, batch: WriteBatch): Promise<SequencedBatch> {
    const plan = this.plans.get(batch.channel)
    if (!plan) throw new Error(`unknown channel: ${batch.channel}`)
    // init() guarantees structured; guard the type and the (unreachable) blob case.
    if (plan.kind !== 'structured') throw new Error(`channel ${batch.channel} is not structured`)

    const resolved: WriteEvent[] = []
    for (const op of batch.ops) {
      const { sql, binds } = structuredStmt(plan, op, pgEncode)
      const { rows } = await c.query(toPg(sql), binds)
      resolved.push(resolveStructured(plan, op, rows, pgDecodeRow))
    }
    // bind the resolved ops as one JSON string → the JSONB column parses it.
    const { rows } = await c.query(toPg(`INSERT INTO _oplog (channel, ops) VALUES (?, ?) RETURNING seq`), [
      batch.channel,
      JSON.stringify(resolved),
    ])
    return { channel: batch.channel, ops: resolved, seq: Number((rows[0] as { seq: unknown }).seq) }
  }

  // Trim the _oplog to the most recent `retention` seqs. Uses the seq magnitude, not
  // a row count, so burned-seq gaps just mean the window holds a few rows fewer than
  // `retention` — harmless (see the init() note). The remaining rows are still the
  // highest seqs, which is all replaySince's floor check needs.
  private async compact(c: PgClient): Promise<void> {
    if (!this.retention) return
    await c.query(toPg(`DELETE FROM _oplog WHERE seq <= (SELECT MAX(seq) FROM _oplog) - ?`), [this.retention])
  }

  async snapshot(): Promise<SequencedBatch[]> {
    const c = await this.conn()
    // one REPEATABLE READ transaction so the watermark and every table are a single
    // consistent cut — no write can slip between reading MAX(seq) and the rows.
    // (The serialize queue already excludes concurrent writes; this locks it in.)
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      const structured = [...this.plans.values()].filter((p): p is StructuredPlan => p.kind === 'structured')
      const seqRes = await c.query<{ s: unknown }>(`SELECT COALESCE(MAX(seq), 0) AS s FROM _oplog`)
      const seq = Number(seqRes.rows[0].s)
      const out: SequencedBatch[] = []
      for (const plan of structured) {
        const { rows } = await c.query(`SELECT * FROM "${plan.name}"`)
        const decoded = rows.map((r) => pgDecodeRow(r, plan.kinds))
        // `reset`: a snapshot replaces the channel (client truncates first);
        // `ready`: the backlog is fully sent. See docs/architecture.md §8.
        out.push({ channel: plan.name, seq, ops: decoded.map((value) => ({ type: 'insert', value })), ready: true, reset: true })
      }
      await c.query('COMMIT')
      return out
    } catch (e) {
      try {
        await c.query('ROLLBACK')
      } catch {
        await this.drop()
      }
      throw e
    }
  }

  // The delta a reconnecting client missed — oplog entries after `since`, in order.
  // Returns null when the cursor predates the oldest retained seq (compacted away),
  // so the caller sends a fresh snapshot instead of a gappy delta. An empty array is
  // a complete delta. Same two-query shape as the other adapters; `ops` comes back
  // already parsed (JSONB), so unlike the SQLite/D1 paths there is no JSON.parse.
  async replaySince(since: number): Promise<SequencedBatch[] | null> {
    const c = await this.conn()
    const minRes = await c.query<{ m: unknown }>(`SELECT MIN(seq) AS m FROM _oplog`)
    const min = Number(minRes.rows[0]?.m ?? 0)
    // min > 0 means everything below it was compacted; if the client's next-needed
    // seq (since+1) is already gone, heal with a snapshot rather than drop rows.
    if (min > 0 && since + 1 < min) return null
    const res = await c.query<{ seq: unknown; channel: string; ops: WriteEvent[] }>(
      toPg(`SELECT seq, channel, ops FROM _oplog WHERE seq > ? ORDER BY seq`),
      [since],
    )
    return res.rows.map((r) => ({ channel: r.channel, seq: Number(r.seq), ops: r.ops }))
  }

  // Constraint classification lives with the dialect, not in a server-side regex:
  // Postgres tags each error with a SQLSTATE on the error's `code`. Two classes
  // are client rejections, everything else is an internal fault (`null` → the
  // server's generic-500 path):
  //
  //  - `42501` insufficient_privilege — an RLS/permission denial: a forged owner
  //    id, a write outside your tenancy, a WITH CHECK your claims don't satisfy.
  //    The database refused THIS USER, not the DATA, so it's a 403 (not a 409) and
  //    the client rolls its optimistic mutation back like any other rejection.
  //    (Note: an UPDATE/DELETE of a row your policy makes INVISIBLE is a 0-row
  //    no-op, not a 42501 — you can't be refused a row you can't see. Only a
  //    visible row failing WITH CHECK, or a forged INSERT, raises 42501.)
  //  - `23…` integrity class (PK/FK/UNIQUE/CHECK/NOT NULL) — a 409 carrying the
  //    violated constraint's real name, strictly better than any message match.
  classifyError(e: unknown): WriteRejection | null {
    const code = (e as { code?: unknown })?.code
    if (typeof code !== 'string') return null
    const error = e instanceof Error ? e.message : String(e)
    if (code === '42501') return { error, status: 403 }
    if (code.startsWith('23')) {
      const constraint = (e as { constraint?: unknown }).constraint
      return typeof constraint === 'string' ? { error, constraint } : { error }
    }
    return null
  }
}
