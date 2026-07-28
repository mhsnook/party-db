// Postgres-native RLS, proven against a REAL Postgres (skips when PG_URL is unset,
// like every PG lane). The identity-injection MECHANICS (which statements the
// adapter emits, in what order) are pinned without a database in
// test/pg-adapter-identity.test.ts; THIS suite proves the thing that only a real
// Postgres can: that the injected claims make the database's OWN Row-Level
// Security policies enforce the write — an authorized write commits, a forged one
// is refused by the DB as SQLSTATE 42501 (→ 403), and a no-auth table behaves
// exactly as before.
//
// The adapter here connects as a dedicated NON-superuser role (`party_db`) — the
// recommended deployment shape: a fixed RLS-subject connection with grants on the
// app tables and the library's `_oplog`, RLS enabled on the app tables, policies
// keyed on the injected `request.jwt.claims`. (A superuser or table owner without
// FORCE bypasses RLS, so the injection would silently buy nothing — this is why
// the connection role matters, and why the test uses `party_db`, not `postgres`.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { z } from 'zod'
import { PgAdapter, type PgClient } from '../../src/server/pg-adapter.ts'
import { definePartyCollection } from '../../src/schema.ts'
import type { WriteBatch } from '../../src/protocol.ts'

const PG_URL = process.env.PG_URL

// `owner` is optional on the wire: omitted, the table's DEFAULT stamps it from the
// injected claim, so a client can never even name someone else's id by leaving it
// off — and naming a foreign one is refused by the policy's WITH CHECK.
const docSchema = z.object({ id: z.string(), owner: z.string().optional(), body: z.string() })
const docs = definePartyCollection({ name: 'docs', key: 'id', schema: docSchema })

const insert = (id: string, body: string, owner?: string): WriteBatch => ({
  channel: 'docs',
  ops: [{ type: 'insert', value: owner === undefined ? { id, body } : { id, owner, body } }],
})
const alice = { claims: { sub: 'alice' } }
const bob = { claims: { sub: 'bob' } }

describe.skipIf(!PG_URL)('Postgres-native RLS (real Postgres, RLS-subject connection role)', () => {
  // admin connection: DDL + assertions. As a superuser it BYPASSES RLS, so its
  // reads see every row regardless of policy — exactly what we want for asserting.
  let admin: pg.Client
  // the adapter's connection: the non-superuser `party_db` role that RLS applies to.
  let app: pg.Client
  const appc: PgClient = { query: (text, values) => app.query(text, values) as any }

  // derive a same-cluster URL for the party_db role from PG_URL (swap the user,
  // KEEP the password): CI authenticates with SCRAM, so party_db needs the same
  // credential as the admin connection — only under local `trust` is it ignored.
  const appPassword = new URL(PG_URL ?? 'postgres://x@x/x').password
  const appUrl = () => {
    const u = new URL(PG_URL!)
    u.username = 'party_db'
    return u.toString()
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG_URL })
    await admin.connect()
    await admin.query(`DROP TABLE IF EXISTS docs, _oplog`)
    // a prior run's `party_db` may still own `_oplog` / hold grants, which blocks a
    // bare DROP ROLE — release what it owns first (guarded: it may not exist).
    await admin.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname='party_db') THEN
        EXECUTE 'DROP OWNED BY party_db'; DROP ROLE party_db;
      END IF; END $$`)
    // give party_db the admin's password so it can log in under SCRAM (CI); under
    // local trust the password is irrelevant.
    await admin.query(`CREATE ROLE party_db NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`)
    // USAGE to reach the schema; CREATE so the adapter's init() can create (and
    // own) the library's `_oplog`. Owning `_oplog` does NOT exempt the role from
    // RLS on the app tables — those are owned by admin, and RLS is per-table.
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO party_db`)
    app = new pg.Client({ connectionString: appUrl() })
    await app.connect()
  })
  afterAll(async () => {
    await app?.end()
    await admin?.query(`DROP TABLE IF EXISTS docs, _oplog`)
    // release everything `party_db` owns / is granted, then drop it.
    await admin?.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname='party_db') THEN
        EXECUTE 'DROP OWNED BY party_db'; DROP ROLE party_db;
      END IF; END $$`).catch(() => {})
    await admin?.end()
  })

  // (re)create the app table with RLS + an owner policy, and the library _oplog,
  // granting the connection role exactly what it needs on both.
  async function setup() {
    await admin.query(`DROP TABLE IF EXISTS docs, _oplog`)
    // `NULLIF(current_setting('request.jwt.claims', true), '')` is the null-safe
    // read of the injected claims: a namespaced setting, once set on a connection,
    // reverts to the EMPTY STRING (not NULL) for later transactions, and a bare
    // `''::json` throws (22P02). NULLIF turns the empty string back into NULL, so a
    // claimless (anonymous) write on a reused connection cleanly FAILS the policy
    // (owner = NULL → not true → 42501) instead of erroring on the cast.
    const claim = `NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub'`
    await admin.query(`
      CREATE TABLE docs (
        id text PRIMARY KEY,
        owner text NOT NULL DEFAULT ${claim},
        body text NOT NULL
      )`)
    await admin.query(`ALTER TABLE docs ENABLE ROW LEVEL SECURITY`)
    await admin.query(`
      CREATE POLICY docs_owner ON docs
        USING (owner = ${claim})
        WITH CHECK (owner = ${claim})`)
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON docs TO party_db`)
    // the connection role creates and OWNS the library-owned `_oplog` (no RLS on
    // it), so it already has every privilege it needs to append/read/compact.
    const adapter = new PgAdapter(() => Promise.resolve(appc), [docs])
    await adapter.init()
    return adapter
  }

  const docRows = async () => (await admin.query(`SELECT id, owner, body FROM docs ORDER BY id`)).rows

  it('authorized write commits, and the owner column is stamped from the claim default', async () => {
    const adapter = await setup()
    const [batch] = await adapter.write([insert('d1', 'hi')], alice) // owner omitted → defaulted
    expect(batch.ops[0].value).toEqual({ id: 'd1', owner: 'alice', body: 'hi' })
    expect(await docRows()).toEqual([{ id: 'd1', owner: 'alice', body: 'hi' }])
  })

  it('a forged owner id is refused by the database (RLS WITH CHECK) → classified 403, nothing committed', async () => {
    const adapter = await setup()
    let err: unknown
    try {
      await adapter.write([insert('d2', 'forge', 'bob')], alice) // alice claims bob's id
    } catch (e) {
      err = e
    }
    expect(err, 'the DB must reject the forged write').toBeDefined()
    expect((err as { code?: string }).code).toBe('42501') // insufficient_privilege
    const rej = adapter.classifyError(err)
    expect(rej!.status).toBe(403)
    // the whole POST rolled back: no row, and the oplog did not grow
    expect(await docRows()).toEqual([])
    expect(Number((await admin.query(`SELECT count(*)::int c FROM _oplog`)).rows[0].c)).toBe(0)
  })

  it("writing a row without any identity is refused (the policy sees no claim) → 403", async () => {
    const adapter = await setup()
    let err: unknown
    try {
      await adapter.write([insert('d3', 'anon', 'anyone')]) // no identity injected at all
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).toBe('42501')
    expect(adapter.classifyError(err)!.status).toBe(403)
  })

  it("update of another user's row is a safe no-op — the policy makes it invisible (not a 403)", async () => {
    const adapter = await setup()
    await adapter.write([insert('shared', 'bobs', 'bob')], bob) // bob owns it
    // alice tries to overwrite it; USING filters bob's row out → 0 rows matched.
    const [batch] = await adapter.write([{ channel: 'docs', ops: [{ type: 'update', value: { id: 'shared', body: 'hacked' }, previousValue: { id: 'shared' } }] }], alice)
    // echoes the sent value (update-of-missing shape), but the stored row is untouched
    expect(batch.ops[0].value).toEqual({ id: 'shared', body: 'hacked' })
    expect(await docRows()).toEqual([{ id: 'shared', owner: 'bob', body: 'bobs' }])
  })

  it("delete of another user's row is a safe no-op — invisible rows can't be deleted", async () => {
    const adapter = await setup()
    await adapter.write([insert('bobdoc', 'bobs', 'bob')], bob)
    await adapter.write([{ channel: 'docs', ops: [{ type: 'delete', value: { id: 'bobdoc' } }] }], alice)
    expect(await docRows()).toEqual([{ id: 'bobdoc', owner: 'bob', body: 'bobs' }]) // still there
  })

  it('each user sees and writes only their own rows across successive writes on the shared connection', async () => {
    const adapter = await setup()
    await adapter.write([insert('a1', 'a-one')], alice)
    await adapter.write([insert('b1', 'b-one')], bob)
    await adapter.write([insert('a2', 'a-two')], alice)
    // the transaction-local setting reverts after each COMMIT, so identities never
    // bleed between writes on the one cached connection.
    expect((await docRows()).map((r) => `${r.owner}:${r.id}`)).toEqual(['alice:a1', 'alice:a2', 'bob:b1'])
  })

  // The anonymous-write latch's boot check: `verifyAnonRole` must accept a real,
  // assumable, RLS-subject role and throw (loudly, at startup) on every unsafe one.
  // The adapter connects as `party_db`, so it can assume itself but not an unrelated
  // role. No table/oplog needed — these only query pg_roles + probe a SET.
  describe('verifyAnonRole (boot latch check)', () => {
    const probe = () => new PgAdapter(() => Promise.resolve(appc), [docs])

    it('resolves for a real, assumable, RLS-subject role', async () => {
      await expect(probe().verifyAnonRole('party_db')).resolves.toBeUndefined()
    })

    it('throws for a role that does not exist', async () => {
      await expect(probe().verifyAnonRole('no_such_role_xyz')).rejects.toThrow(/does not exist/i)
    })

    it('throws for a role that bypasses RLS (superuser / BYPASSRLS)', async () => {
      // `postgres` is the superuser — an anon role that bypasses RLS would let
      // anonymous writes past every policy, the exact thing the latch prevents.
      await expect(probe().verifyAnonRole('postgres')).rejects.toThrow(/bypass|BYPASSRLS/i)
    })

    it('throws when the connection role cannot assume it', async () => {
      await admin.query(`DROP ROLE IF EXISTS probe_unassumable`)
      await admin.query(`CREATE ROLE probe_unassumable NOSUPERUSER NOBYPASSRLS`) // party_db is NOT a member
      try {
        await expect(probe().verifyAnonRole('probe_unassumable')).rejects.toThrow(/cannot assume/i)
      } finally {
        await admin.query(`DROP ROLE IF EXISTS probe_unassumable`)
      }
    })
  })
})

// A table WITHOUT RLS, written with no identity: the whole feature must be inert.
// This is the back-compat guarantee — a party that never sets `auth` behaves
// exactly as it did before identity injection existed.
describe.skipIf(!PG_URL)('no-auth Postgres path is unchanged (no RLS, no identity)', () => {
  let client: pg.Client
  const pgc: PgClient = { query: (text, values) => client.query(text, values) as any }
  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client?.query(`DROP TABLE IF EXISTS plain, _oplog`)
    await client?.end()
  })

  it('writes commit and resolve exactly as before when no identity is threaded', async () => {
    await client.query(`DROP TABLE IF EXISTS plain, _oplog`)
    await client.query(`CREATE TABLE plain (id text PRIMARY KEY, body text NOT NULL)`)
    const plain = definePartyCollection({ name: 'plain', key: 'id', schema: z.object({ id: z.string(), body: z.string() }) })
    const adapter = new PgAdapter(() => Promise.resolve(pgc), [plain])
    await adapter.init()
    const [batch] = await adapter.write([{ channel: 'plain', ops: [{ type: 'insert', value: { id: 'x', body: 'y' } }] }])
    expect(batch.ops[0].value).toEqual({ id: 'x', body: 'y' })
    expect(batch.seq).toBe(1)
  })
})
