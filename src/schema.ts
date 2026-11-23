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

// Who may perform a given CRUD verb on a collection. Enforced by the server at the
// write gate, the snapshot, the `?since` backlog, and the fan-out
// (docs/architecture.md §17; cookbook 5). The uid is the `auth` hook's `sub` claim.
//   'public' — anyone, signed in or not
//   'authed' — any request carrying a verified uid (no ownership tie)
//   'owner'  — only the row's owner (requires `ownerColumn`, matched to the uid)
//   'none'   — no one through CRUD; managed out-of-band (admin tools, jobs, RPC)
export type AccessPolicy = 'public' | 'authed' | 'owner' | 'none'

// A grant: met by the row's owner (`owner: true`), or by a signed-in user holding
// any of `roles`. The roles are the `auth` hook's `claims.roles`, an array of
// strings. They are not `WriteIdentity.role`, which is the Postgres role a write
// runs as. `{ owner: true, roles: ['editor'] }` means the owner or an editor.
export type AccessGrant = { owner?: true; roles?: readonly string[] }

export type VerbAccess = AccessPolicy | AccessGrant

// A single policy or grant applies to all four verbs; the object form sets them
// per-verb, and any verb you DON'T name is denied ('none') — deny by default. So a
// public, append-only catalog is `{ read: 'public', insert: 'authed' }`: everyone
// reads, members add, nobody edits or deletes through CRUD.
export type Access =
  | VerbAccess
  | { read?: VerbAccess; insert?: VerbAccess; update?: VerbAccess; delete?: VerbAccess }

// The columns of `T` that can hold a user id: a string or a number. `users.id` is
// a SERIAL as often as it is a uuid, and we never ask you to change your tables,
// so both sides are compared as text (`idOf`) — an integer 1 matches the `sub`
// claim "1". What is refused is a column that cannot be an id at all: a boolean,
// an object, an array. A schema-less collection has no typed columns, so every
// name stays allowed there and `checkAccess`'s boot check is the only gate.
export type UidColumn<T> = string extends keyof T
  ? keyof T & string
  : { [K in keyof T]-?: NonNullable<T[K]> extends string | number | bigint ? K : never }[keyof T] & string

// `Name` and `Key` keep the literal collection name and key column, so
// `createPartyDb` can type `db.todos` as `Collection<Todo, string>`.
export type PartyCollection<
  T extends object = Record<string, unknown>,
  Name extends string = string,
  Key extends keyof T & string = keyof T & string,
> = {
  name: Name // channel === table name
  key: Key // primary key field → getKey
  schema?: StandardSchemaV1<T> // shared Zod/StandardSchema: types + validation
  // The column whose value must equal the writer's uid for any 'owner' rule. This
  // is the simple string-equality fast path; naming it with no `access` is sugar
  // for fully private (owner on all four verbs). (Ownership that isn't a column ===
  // uid — e.g. "a friend of the owner" — is a later, function-based form; this
  // field stays the cheap, common case.)
  ownerColumn?: UidColumn<T>
  // Per-verb access rules. Omitted → 'public' on all four verbs, unless
  // `ownerColumn` is set, which defaults to 'owner' on all four.
  access?: Access
  // Load this collection by slice instead of whole: a client gets only the rows
  // whose `sliceBy` column matches what its live queries ask for, and only the
  // writes to those slices stream to it. Setting it makes the client collection
  // on-demand (TanStack's `syncMode: 'on-demand'`), so a live query's `where` is
  // the subscription. The column must never change on a row: an update that
  // carries it is refused (docs/architecture.md §18).
  sliceBy?: UidColumn<T>
  // `false` skips the connect-time load: a connecting client gets no rows for this
  // collection, only a `ready` marker, and tails the fan-out from there. The table
  // and the `_oplog` are untouched, so a reconnect still replays what it missed
  // (docs/architecture.md §8). Default `true`.
  snapshot?: boolean
}

// Identity helper: infers the row type from `schema` and keeps `name` literal, so
// `createPartyDb` returns `db.<name>` typed by that row. Same value back; it only
// exists for the types.
//
// Passing the row type explicitly (`definePartyCollection<Todo>(...)`) checks `key`
// against it, but TypeScript then cannot infer the name: that collection is typed
// on `db` as `Collection<any>`, as before. Let the schema carry the type instead.
export function definePartyCollection<
  T extends object = Record<string, unknown>,
  const Name extends string = string,
  const Key extends keyof T & string = keyof T & string,
>(cfg: PartyCollection<T, Name, Key>): PartyCollection<T, Name, Key> {
  return cfg
}
