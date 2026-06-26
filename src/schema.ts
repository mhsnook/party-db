// The one collection interface, defined once and imported on both sides. There
// is no separate server `TableDef`: client and server describe a collection with
// the same three things — its name (=== channel === your table name), its primary
// key field, and the StandardSchema (Zod) that already powers the client.
//
// The server does NOT own your schema or your DDL — you bring your own database
// and tables. The server reads this `schema` only to (a) build an injection-safe
// column allowlist and value codec for CRUD against the columns you already have,
// and (b) optionally validate rows as a cheap error-sooner gate. The database is
// the authority.

import type { StandardSchemaV1 } from '@standard-schema/spec'

export type PartyCollection<T extends object = Record<string, unknown>> = {
  name: string // channel === table name
  key: keyof T & string // primary key field → getKey
  schema?: StandardSchemaV1<T> // shared Zod/StandardSchema: types + validation
}

// Identity helper: gives you inference on `key` against the schema's type without
// widening. Same value back; it only exists for the types.
export function definePartyCollection<T extends object>(cfg: PartyCollection<T>) {
  return cfg
}
