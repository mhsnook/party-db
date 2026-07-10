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

// Who may perform a given CRUD verb on a collection. Enforcement is SERVER-SIDE
// (proposed — see docs/cookbooks/05 and postgres-todo.md §5); these types are the
// userspace surface it's written backwards from.
//   'public' — anyone, signed in or not
//   'authed' — any request carrying a verified uid (no ownership tie)
//   'owner'  — only the row's owner (requires `ownerColumn`, matched to the uid)
//   'none'   — no one through CRUD; managed out-of-band (admin tools, jobs, RPC)
export type AccessPolicy = 'public' | 'authed' | 'owner' | 'none'

// A single policy applies to all four verbs; the object form sets them per-verb,
// and any verb you DON'T name is denied ('none') — deny by default. So a public,
// append-only catalog is `{ read: 'public', insert: 'authed' }`: everyone reads,
// members add, nobody edits or deletes through CRUD.
export type Access =
  | AccessPolicy
  | { read?: AccessPolicy; insert?: AccessPolicy; update?: AccessPolicy; delete?: AccessPolicy }

export type PartyCollection<T extends object = Record<string, unknown>> = {
  name: string // channel === table name
  key: keyof T & string // primary key field → getKey
  schema?: StandardSchemaV1<T> // shared Zod/StandardSchema: types + validation
  // The column whose value must equal the writer's uid for any 'owner' rule. This
  // is the simple string-equality fast path; naming it with no `access` is sugar
  // for fully private (owner on all four verbs). (Ownership that isn't a column ===
  // uid — e.g. "a friend of the owner" — is a later, function-based form; this
  // field stays the cheap, common case.)
  ownerColumn?: keyof T & string
  // Per-verb access rules. Omitted → 'public' on all four verbs, unless
  // `ownerColumn` is set, which defaults to 'owner' on all four.
  access?: Access
}

// Identity helper: gives you inference on `key` against the schema's type without
// widening. Same value back; it only exists for the types.
export function definePartyCollection<T extends object>(cfg: PartyCollection<T>) {
  return cfg
}
