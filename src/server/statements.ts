// The SQL the two SQLite-dialect adapters share. Pure builders: given a plan and
// a WriteEvent they return `{ sql, binds }` (and a decode recipe) WITHOUT touching
// any engine — so the embedded adapter can run them one-by-one inside its
// interactive transaction, and the D1 adapter can pack them all into one up-front
// `batch()`.
//
// Two families live here:
//   - CRUD builders (`structuredStmt` / `blobStmt`) + `resolveStructured`: the
//     insert/update/delete text the embedded adapter used to inline, unchanged.
//   - `resolvedOpJsonExpr`: the piece the embedded adapter never needed. D1 has no
//     interactive transaction, so it cannot decode a RETURNING row in JS and then
//     INSERT the resolved-op JSON — the two would be different statements. Instead
//     the oplog INSERT assembles that JSON *in SQL*, reading back the row the
//     batch's earlier CRUD statement just wrote. This builder emits that per-op
//     expression, generated from the same `kinds` map `decodeRow` reads.
//
// Injection-safety is unchanged from the embedded adapter: every value is bound
// with `?`, every identifier comes from the schema allowlist (assertIdent), never
// from the payload's keys.

import type { WriteEvent } from '../protocol.ts'
import type { PartyCollection } from '../schema.ts'
import { assertIdent, columnsOf, decodeRow, encode, type ColumnKind, type ColumnSpec } from './columns.ts'

export type StructuredPlan = {
  kind: 'structured'
  name: string
  key: string
  cols: ColumnSpec[]
  kinds: Map<string, ColumnKind>
}
export type BlobPlan = { kind: 'blob'; name: string; key: string }
export type Plan = StructuredPlan | BlobPlan

// Read each collection into its persistence plan: a schema we can introspect →
// structured CRUD against your real columns; otherwise the schema-agnostic blob
// store (embedded only — the D1 adapter rejects blob plans at init). Identifiers
// are validated here, once, at construction.
export function buildPlans(collections: PartyCollection<any>[]): Map<string, Plan> {
  const plans = new Map<string, Plan>()
  for (const c of collections) {
    const name = assertIdent(c.name)
    const key = assertIdent(c.key)
    const cols = columnsOf(c.schema)
    plans.set(
      name,
      cols
        ? { kind: 'structured', name, key, cols, kinds: new Map(cols.map((col) => [col.name, col.kind])) }
        : { kind: 'blob', name, key },
    )
  }
  return plans
}

export type Statement = { sql: string; binds: unknown[] }

// CRUD against your real columns for one structured op. `insert`/`update`/`delete`
// are distinct statements (not a blanket upsert) so the database's own constraints
// get to accept or reject. insert/update use RETURNING * to hand back the resolved
// row (defaults, serials, generated columns); delete needs no read.
//
// `enc` is the value codec: the default SQLite `encode` (booleans → 0/1, json →
// text). The PG adapter passes `pgEncode` instead (native booleans, json as text
// PG casts) — the ONE dialect difference on the bind side. Identifiers and SQL
// shape are engine-agnostic; the `?` placeholders are rewritten to `$1…$n` by
// `toPg` for PG.
export function structuredStmt(plan: StructuredPlan, op: WriteEvent, enc: (v: unknown) => unknown = encode): Statement {
  const row = op.value as Record<string, unknown>
  const table = plan.name

  if (op.type === 'delete') {
    return { sql: `DELETE FROM "${table}" WHERE "${plan.key}" = ?`, binds: [enc(row[plan.key])] }
  }

  if (op.type === 'update') {
    // SET only the columns the client actually sent (from the allowlist, not the
    // payload keys), keyed by the PK. Untouched columns keep their value.
    const set = plan.cols.filter((c) => c.name !== plan.key && row[c.name] !== undefined)
    return set.length
      ? {
          sql: `UPDATE "${table}" SET ${set.map((c) => `"${c.name}" = ?`).join(', ')} WHERE "${plan.key}" = ? RETURNING *`,
          binds: [...set.map((c) => enc(row[c.name])), enc(row[plan.key])],
        }
      : // a no-op update (only the key present): just read the current row back.
        { sql: `SELECT * FROM "${table}" WHERE "${plan.key}" = ?`, binds: [enc(row[plan.key])] }
  }

  // insert: name only the columns present in the payload, so columns the client
  // omitted fall to the DB's defaults / serials — and RETURNING hands those back.
  const cols = plan.cols.filter((c) => row[c.name] !== undefined)
  return {
    sql: `INSERT INTO "${table}" (${cols.map((c) => `"${c.name}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`,
    binds: cols.map((c) => enc(row[c.name])),
  }
}

// Rewrite a `?`-placeholder statement (what the builders emit) into Postgres'
// `$1…$n` positional form. Our builders only ever emit `?` as a value placeholder
// — every value is bound, never inlined, and identifiers are double-quoted — so a
// straight left-to-right substitution is exact (no `?` hides inside a literal).
export function toPg(sql: string): string {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

// v0 blob store: one JSON row per PK. The resolved row equals the sent row.
export function blobStmt(plan: BlobPlan, op: WriteEvent): Statement {
  const row = op.value as Record<string, unknown>
  const key = String(row[plan.key])
  if (op.type === 'delete') {
    return { sql: `DELETE FROM "${plan.name}" WHERE k = ?`, binds: [key] }
  }
  return {
    sql: `INSERT INTO "${plan.name}" (k, data) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data`,
    binds: [key, JSON.stringify(row)],
  }
}

// Turn the rows a structured statement returned into the resolved op. insert and a
// row-hitting update decode the RETURNING row (defaults/serials applied); an update
// that hit no row and a delete echo the sent value. This is the JS side of what
// `resolvedOpJsonExpr` reproduces in SQL — the two must agree (parity test).
//
// `dec` decodes a RETURNING row → its schema shape; the default is the SQLite
// `decodeRow`. The PG adapter passes `pgDecodeRow` (native booleans, json already
// parsed by the driver). insert/update decode the returned row; a missed update
// and a delete echo the sent value with no decode.
export function resolveStructured(
  plan: StructuredPlan,
  op: WriteEvent,
  rows: Record<string, unknown>[],
  dec: (row: Record<string, unknown>, kinds: Map<string, ColumnKind>) => Record<string, unknown> = decodeRow,
): WriteEvent {
  const row = op.value as Record<string, unknown>
  if (op.type === 'delete') return { type: 'delete', value: row }
  if (op.type === 'update') {
    const resolved = rows[0]
    return { type: 'update', value: resolved ? dec(resolved, plan.kinds) : row, previousValue: op.previousValue }
  }
  return { type: 'insert', value: dec(rows[0], plan.kinds) }
}

// The SQL mirror of `decode` for one column, as a `json_object` value expression:
//   - boolean: the stored 0/1 (or NULL) → a JSON true/false/null via json(); a bare
//     0/1 would embed as a number, and "true" as a string — both wrong.
//   - json:    json(col) re-parses the stored JSON text so it embeds as the object
//     it is, not a double-encoded string. json(NULL) is NULL → JSON null.
//   - scalar:  the bare column; json_object types it (text→string, int→number,
//     NULL→null) exactly as `decode`'s passthrough would.
function columnJsonExpr(col: ColumnSpec): string {
  const id = `"${col.name}"`
  if (col.kind === 'boolean') return `json(CASE WHEN ${id} IS NULL THEN 'null' WHEN ${id} = 0 THEN 'false' ELSE 'true' END)`
  if (col.kind === 'json') return `json(${id})`
  return id
}

// One op's resolved-op JSON, assembled in SQL for the oplog INSERT. Returns the
// expression text plus its binds, to be dropped into a `json_array(...)`.
//
// insert/update read the row back from the table by key and shape it with the
// schema's columns; a COALESCE fallback to the pre-serialized sent op covers the
// update-of-a-missing-row no-op (empty subquery → echo the sent value). delete's
// value is the sent row, known up front. The outer json() is load-bearing: the
// JSON subtype does not survive the scalar-subquery boundary, so each element is
// re-parsed. Bind order matches the `?`s left-to-right: [previousValue?, key,
// fallback] for insert/update; [sentOp] for delete.
export function resolvedOpJsonExpr(plan: StructuredPlan, op: WriteEvent): { expr: string; binds: unknown[] } {
  const row = op.value as Record<string, unknown>

  if (op.type === 'delete') {
    return { expr: 'json(?)', binds: [JSON.stringify({ type: 'delete', value: row })] }
  }

  const hasPrev = op.type === 'update' && op.previousValue !== undefined
  const valueObj = `json_object(${plan.cols.map((c) => `'${c.name}', ${columnJsonExpr(c)}`).join(', ')})`
  const objectPairs = [
    `'type', '${op.type}'`,
    `'value', ${valueObj}`,
    ...(hasPrev ? [`'previousValue', json(?)`] : []),
  ].join(', ')
  const subquery = `SELECT json_object(${objectPairs}) FROM "${plan.name}" WHERE "${plan.key}" = ?`
  const fallback: WriteEvent =
    op.type === 'update'
      ? { type: 'update', value: row, ...(hasPrev ? { previousValue: op.previousValue } : {}) }
      : { type: 'insert', value: row }

  return {
    expr: `json(COALESCE((${subquery}), ?))`,
    binds: [...(hasPrev ? [JSON.stringify(op.previousValue)] : []), encode(row[plan.key]), JSON.stringify(fallback)],
  }
}

// The oplog append for one channel-batch: `json_array(...)` over the per-op
// expressions, RETURNING the AUTOINCREMENT seq the batch was assigned. Binds are
// [channel, ...each op's binds in order].
export function oplogInsertStmt(channel: string, ops: WriteEvent[], plan: StructuredPlan): Statement {
  const exprs = ops.map((op) => resolvedOpJsonExpr(plan, op))
  return {
    sql: `INSERT INTO _oplog (channel, ops) VALUES (?, json_array(${exprs.map((e) => e.expr).join(', ')})) RETURNING seq`,
    binds: [channel, ...exprs.flatMap((e) => e.binds)],
  }
}
