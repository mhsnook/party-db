# Postgres RLS: identity-aware writes

Make `/write` **identity-aware on Postgres** so a client's writes can only do what
the authenticated user is allowed to do — with **Postgres' own Row-Level Security**
doing the enforcement, not any logic you write. You carry the caller's verified
identity into the write transaction; your RLS policies decide what each insert /
update / delete may touch; forgeries — writing rows you don't own, stamping someone
else's id — are refused by the database and come back `403`. ✅ (Postgres only.)

This is the real thing, not a JS approximation. The library injects the identity and
gets out of the way.

## The seam: `auth` on the server

`auth` is a function you add to your `PartyDbServer`, resolved **fresh on every POST**
(a write must never trust a stale identity). You verify the token — the library
validates nothing, exactly like the lobby `authorize` seam ([recipe 3](./03-external-auth-workos.md))
— and return the verified claims (and, optionally, a Postgres role).

```ts
import { PartyDbServer, PgAdapter, definePartyCollection, getTokenFromRequest, type PgClient, type WriteIdentity, type PersistenceAdapter } from 'party-db/server'
import { jwtVerify, createRemoteJWKSet } from 'jose'
import { docSchema, type Doc } from './schema.ts'

const JWKS = createRemoteJWKSet(new URL(jwksUrl)) // your IdP's public keys

export class Room extends PartyDbServer {
  collections = [definePartyCollection<Doc>({ name: 'docs', key: 'id', schema: docSchema })]

  // Resolve identity per POST. Return the verified claims → injected as
  // `request.jwt.claims`; return null for an anonymous write. A throw is a 401.
  // What "null" DOES is fail-closed by default — see "No token" below.
  auth = async (req: Request): Promise<WriteIdentity | null> => {
    const token = getTokenFromRequest(req) // Bearer on the POST (our convention)
    if (!token) return null
    const { payload } = await jwtVerify(token, JWKS) // your verification, your call
    return { claims: { sub: payload.sub as string, org: payload.org as string } }
  }

  // Point the adapter at an RLS-SUBJECT role (see below) — NOT a superuser.
  protected createAdapter(): PersistenceAdapter {
    return new PgAdapter(async () => {
      const { default: pg } = await import('pg')
      const client = new pg.Client({ connectionString: this.env.DATABASE_URL }) // a party_db role
      await client.connect()
      return client as unknown as PgClient
    }, this.collections)
  }
}
```

That's the whole app side. The claims you return are injected at the top of the write
transaction with the parameterized, transaction-scoped
`SELECT set_config('request.jwt.claims', $1, true)` — no per-user connection pooling,
no string-built SQL. Everything else is Postgres.

## The database: policies + owner defaults

Enable RLS on your table and write an owner policy keyed on the injected claim. Two
details are load-bearing:

```sql
-- read the injected claim, null-safe. A namespaced setting reverts to the EMPTY
-- STRING (not NULL) on a reused connection, and a bare ''::json throws (22P02);
-- NULLIF turns it back into NULL so a claimless write DENIES cleanly.
CREATE OR REPLACE FUNCTION jwt_sub() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub'
$$;

CREATE TABLE docs (
  id    text PRIMARY KEY,
  -- omit `owner` on the wire and the DB stamps it from the claim — the client can't
  -- even name someone else's id, and naming a foreign one fails WITH CHECK below.
  owner text NOT NULL DEFAULT jwt_sub(),
  body  text NOT NULL
);

ALTER TABLE docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY docs_owner ON docs
  USING      (owner = jwt_sub())   -- which rows you can SEE / target (SELECT/UPDATE/DELETE)
  WITH CHECK (owner = jwt_sub());  -- what an INSERT/UPDATE may leave behind
```

- **Forged insert** (`owner = 'someone_else'`, or a claim that isn't yours) → `WITH
  CHECK` fails → SQLSTATE `42501` → **403** at the wire; the whole POST rolls back.
- **Anonymous write** that *reaches* the DB (no claim) → `owner = NULL` is never true →
  **403**. But by default an anonymous write never gets that far — it's rejected 401 at
  the server before any SQL (see [No token](#no-token-fail-closed-by-default) below).
- **Update/delete of a row you can't see** → `USING` filters it out → **0 rows matched**
  (not a 403). You cannot be refused a row that is invisible to you, and that is safe.
  An update of 0 rows is then the **missing-row rejection**: **409** with
  `code: 'missing-row'`, the POST rolled back, so the writer learns their write went
  nowhere ([architecture §16](../architecture.md#16-an-update-sends-tanstacks-changes-and-must-hit-a-row)).
  A delete of 0 rows stays a no-op — the row is already gone.
  To make cross-user *modification* of a visible row a hard 403 (org-tenancy: you see
  colleagues' rows but can't edit them), widen `USING` to the org and keep `WITH CHECK`
  on the owner — a visible row failing `WITH CHECK` raises `42501`.

## The connection role must be RLS-subject

The single most important operational rule: **the role the adapter connects as must be
subject to RLS.** A superuser, a `BYPASSRLS` role, or the table's owner *without*
`FORCE ROW LEVEL SECURITY` bypasses every policy — the injection then enforces nothing.
Use a dedicated role that has DML on your tables and on the library-owned `_oplog`, but
owns neither:

```sql
CREATE ROLE party_db NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '…';
GRANT USAGE, CREATE ON SCHEMA public TO party_db;      -- CREATE lets init() make _oplog
GRANT SELECT, INSERT, UPDATE, DELETE ON docs TO party_db;
-- if you pre-create _oplog in a migration instead, grant DML + its sequence:
--   GRANT SELECT, INSERT, DELETE ON _oplog TO party_db;
--   GRANT USAGE, SELECT ON SEQUENCE _oplog_seq_seq TO party_db;
```

`DATABASE_URL` then points at `party_db`. When `init()` creates `_oplog`, `party_db`
owns it — which is fine: RLS is per-table, `_oplog` carries no policies, and owning it
does not exempt `party_db` from the policies on `docs` (owned by your migration role).

### `SET LOCAL role` instead of a dedicated connection

If you model tenants/users as Postgres roles, return `{ role, claims }` and the adapter
also issues `set_config('role', …, true)` — the transaction assumes that role before
touching any data, so a single privileged connection can serve many RLS-subject roles.
The assumed role still needs DML on your tables and `_oplog`. Prefer the dedicated
RLS-subject *connection* (claims-only) unless you already run per-role Postgres tenancy.

## No token: fail-closed by default

Here is the sharp edge, and how the library blunts it. "No token" means your `auth`
returned `null`. What must **not** happen is the write running with no injected
identity: on a privileged connection that would execute as the privileged role with
**RLS bypassed** — an attacker just omits the `Authorization` header and writes straight
through your policies. Note that only a *role switch* drops privilege; an absent *claim*
does not, so "inject nothing" is not safe there.

So when `auth` is set, party-db is **fail-closed**: an anonymous write is **rejected
401 before any transaction opens**. There is exactly one way to allow anonymous writes,
and it is a deliberate latch — name an `anonRole`:

```ts
export class Room extends PartyDbServer {
  // …auth, createAdapter as above…
  anonRole = 'anon' // tokenless writes run as the RLS-subject `anon` role — omit to reject them
}
```

With it set, an anonymous write runs as `SET LOCAL role anon`: the server assigns that
role itself (nothing from the client is trusted — there is no anonymous "token" to
forge), and because it's a *role switch* it governs the write even on a privileged
connection. Your policies then decide (a 403 if `anon` may not do it). The `anon` role
is the Supabase shape — anonymous traffic is a real, low-privilege role, never the
connection's own.

Two properties make this a latch, not a loophole:

- **Explicit, not inferred.** `anonRole` is a config line you write, never defaulted and
  never auto-detected from a role that happens to be named `anon` — creating a database
  role for some unrelated reason must not silently flip your app from "reject anonymous"
  to "accept anonymous." Opening the door is a decision.
- **Verified at boot.** When `anonRole` is set, `onStart` proves the role is real and
  safe *before serving a request* — it exists, this connection can assume it, and it does
  **not** bypass RLS (a superuser / `BYPASSRLS` anon role is refused). A misconfigured
  latch throws at startup, not on the first anonymous write.

Set up the role to match:

```sql
CREATE ROLE anon NOSUPERUSER NOBYPASSRLS;          -- RLS-subject, low privilege
GRANT anon TO party_db;                            -- so the connection role may SET ROLE anon
GRANT SELECT, INSERT ON <public tables> TO anon;   -- exactly what anonymous may touch
-- …plus the RLS policies that govern anon, on those tables.
```

## What this is not

- **Not a JS access-policy engine.** Owner-column stamping in the library, `ownerColumns`
  maps, AND/OR tenancy resolved in TypeScript — that's the separate, database-agnostic
  "RLS in the JS layer" work ([recipes 5](./05-public-and-private-collections.md) &
  [6](./06-friends-only-posts.md)). This recipe is Postgres-native only.
- **Not reads.** This secures *writes*. Identity-aware snapshots / `?since` backlog /
  per-socket fan-out filtering are later work; a connected socket still reads by the
  lobby gate ([recipe 4](./04-public-read-private-write.md)) until then.
- **Not SQLite / D1.** They have no RLS; the injected identity is ignored there, and a
  server with no `auth` behaves exactly as before.
