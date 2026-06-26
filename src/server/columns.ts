// Read the shared StandardSchema (Zod) into the two things the structured server
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
// Returns null when the schema isn't a Zod object we can introspect; the caller
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

export function columnsOf(schema: StandardSchemaV1 | undefined): ColumnSpec[] | null {
  const shape = zodShape(schema)
  if (!shape) return null
  return Object.entries(shape).map(([name, field]) => ({
    name: assertIdent(name),
    kind: kindOf(field),
  }))
}

// Zod (v3) exposes its object shape as `.shape`; tolerate the lazy `_def.shape()`
// form too. Anything without a shape (a non-object schema, or a non-Zod
// StandardSchema) returns null → blob fallback.
function zodShape(schema: unknown): Record<string, unknown> | null {
  const s = schema as any
  if (!s) return null
  const shape = s.shape ?? s._def?.shape?.()
  return shape && typeof shape === 'object' ? shape : null
}

// Peel Optional/Nullable/Default/Effects wrappers to reach the base type, then
// classify it for the codec. Unknown types are treated as scalar (bound as-is).
function kindOf(field: unknown): ColumnKind {
  let cur = field as any
  while (cur?._def) {
    const tn = cur._def.typeName
    if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault') {
      cur = cur._def.innerType
      continue
    }
    if (tn === 'ZodEffects') {
      cur = cur._def.schema
      continue
    }
    break
  }
  const tn = cur?._def?.typeName
  if (tn === 'ZodBoolean') return 'boolean'
  if (
    tn === 'ZodObject' ||
    tn === 'ZodArray' ||
    tn === 'ZodRecord' ||
    tn === 'ZodTuple' ||
    tn === 'ZodMap' ||
    tn === 'ZodSet'
  ) {
    return 'json'
  }
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
