// Read the shared StandardSchema (Zod v4) into the two things the structured server
// needs to do CRUD against tables you already built: an injection-safe column
// ALLOWLIST and a value CODEC. We deliberately do NOT derive SQL types, defaults,
// PKs, or any DDL — your app owns its database and its schema. This is only:
//
//   - which column names the server is allowed to name in a statement
//     (taken from the schema, validated against an identifier regex — NEVER from
//     the client payload's keys), and
//   - how to (de)serialize a value across SQLite's narrow type set, since SQLite
//     can't bind a JS boolean or object: booleans ↔ 0/1, objects/arrays ↔ JSON.
//
// Returns null when the schema isn't a Zod v4 object we can introspect; the caller
// then falls back to the schema-agnostic blob store (v0).

import type { StandardSchemaV1 } from '@standard-schema/spec'

// A column's logical type, only as far as the value codec cares.
export type ColumnKind = 'boolean' | 'json' | 'scalar'
export type ColumnSpec = { name: string; kind: ColumnKind }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

// Every table/column name we put into SQL passes through here. They come from the
// schema/config, not the wire — this is belt-and-suspenders against a stray
// non-identifier sneaking into a statement we build by hand.
export function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`)
  return name
}

// `unknown` so an undefined tag is just a miss, with no truthiness guard at the
// call site.
const JSON_TAGS: ReadonlySet<unknown> = new Set(['object', 'array', 'record', 'tuple', 'map', 'set'])

export function columnsOf(schema: StandardSchemaV1 | undefined): ColumnSpec[] | null {
  const shape = zodShape(schema)
  if (!shape) return null
  return Object.entries(shape).map(([name, field]) => ({
    name: assertIdent(name),
    kind: kindOf(field),
  }))
}

// Every Zod v4 node carries its definition at `_zod.def` — an own property on the
// instance, and the one spelling shared by `zod`, `zod/mini`, and `zod/v4/core`.
// (`_def` is a prototype alias for the same object; we read the canonical one.)
// Anything without a def is not a Zod schema.
function zodDef(node: unknown): Record<string, any> | null {
  const def = (node as any)?._zod?.def
  return def && typeof def === 'object' ? def : null
}

// The node's tag: 'object', 'boolean', 'pipe'. Undefined for anything that is not
// a Zod v4 node, and the caller then calls it a scalar.
function typeTag(node: unknown): string | undefined {
  const tag = zodDef(node)?.type
  return typeof tag === 'string' ? tag : undefined
}

// A Zod v4 object's shape. Anything else (a non-object schema, or a StandardSchema
// from another library) returns null → blob fallback.
function zodShape(schema: unknown): Record<string, unknown> | null {
  const shape = zodDef(schema)?.shape
  return shape && typeof shape === 'object' ? shape : null
}

// Peel Optional/Nullable/Default and the transform wrapper to reach the base type,
// then classify it. Unknown types are scalar (bound as-is). `.transform()` leaves
// the base type on the pipe's `in` side, `z.preprocess()` on its `out` side, so we
// follow the side that is not the transform.
function kindOf(field: unknown): ColumnKind {
  let cur: any = field
  while (true) {
    const tag = typeTag(cur)
    if (tag === 'optional' || tag === 'nullable' || tag === 'default') cur = zodDef(cur)!.innerType
    else if (tag === 'pipe') {
      const def = zodDef(cur)!
      cur = typeTag(def.in) === 'transform' ? def.out : def.in
    } else break
  }
  const tag = typeTag(cur)
  if (tag === 'boolean') return 'boolean'
  if (JSON_TAGS.has(tag)) return 'json'
  return 'scalar'
}

// JS value → a value SQLite can bind (null | number | string | bigint). Driven by
// the value's own runtime type, so it needs no per-column info: a boolean is 0/1,
// an object/array is JSON. Strings/numbers pass through; undefined/null → null.
export function encode(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

// A column value coming back from SQLite (e.g. via RETURNING) → its schema shape.
// This one needs the column's kind: the database hands back 0/1 and JSON text and
// only the schema knows they were a boolean / an object.
export function decode(raw: unknown, kind: ColumnKind): unknown {
  if (raw === null || raw === undefined) return null
  if (kind === 'boolean') return Boolean(raw)
  if (kind === 'json') return typeof raw === 'string' ? JSON.parse(raw) : raw
  return raw
}

// Decode a whole RETURNING row: known columns by their kind, unknown columns
// (generated/extra columns not in the schema) passed through untouched.
export function decodeRow(
  row: Record<string, unknown>,
  kinds: Map<string, ColumnKind>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = decode(v, kinds.get(k) ?? 'scalar')
  return out
}

// The Postgres value codec. Postgres has native types where SQLite has only its
// narrow set, so this codec is thinner than the SQLite one above — the difference
// is the whole "dialect seam" the PG adapter needs, kept beside its SQLite sibling
// rather than forked into the adapter.

// JS value → a Postgres bind. Unlike SQLite's `encode`, booleans stay NATIVE (PG
// has a real bool type — no 0/1) and objects/arrays are JSON.stringify'd once so
// they bind as text PG casts into json/jsonb — binding a raw JS array would
// otherwise be read as a Postgres array, not JSON. Strings/numbers pass through;
// undefined/null → null.
export function pgEncode(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

// A Postgres RETURNING value → its schema shape. The driver already hands back
// native types (a real boolean, and json/jsonb pre-parsed to a JS value), so
// unlike SQLite's `decode` there's no 0/1 or JSON text to reverse: we only
// normalize null/undefined and coerce booleans defensively. Scalars — including a
// bigint column, which the driver returns as a string — pass through as the driver
// gave them.
export function pgDecode(raw: unknown, kind: ColumnKind): unknown {
  if (raw === null || raw === undefined) return null
  if (kind === 'boolean') return Boolean(raw)
  return raw
}

export function pgDecodeRow(
  row: Record<string, unknown>,
  kinds: Map<string, ColumnKind>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = pgDecode(v, kinds.get(k) ?? 'scalar')
  return out
}
