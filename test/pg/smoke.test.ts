// Node-lane Postgres smoke tests: the driver behaviours a Postgres adapter must
// build on, pinned as assertions so a driver upgrade that changes any of them
// fails loudly. Driven against the raw `pg` client, no adapter involved.
//
//   - constraint-violation error shape from `pg`: SQLSTATE in `.code`, and the
//     violated constraint's *name* on the error (`.constraint`). Classification
//     keys on the SQLSTATE, not a message regex.
//   - the JS types the driver hands back per column kind (see src/server/columns.ts):
//     boolean (native bool, not 0/1), json/jsonb (driver parses for you),
//     serial/integer (number), and bigint (comes back as a *string* — the one that
//     bites).
//
// Skips cleanly when PG_URL is unset so `pnpm test` and contributors without
// docker never fail for want of a Postgres.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'

const PG_URL = process.env.PG_URL

// A fresh, uniquely-named table per run keeps the shared CI Postgres from
// cross-contaminating between suites/retries.
const TABLE = 'party_db_smoke'

describe.skipIf(!PG_URL)('Postgres node lane', () => {
  let client: pg.Client

  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`)
    // the column kinds columns.ts distinguishes (scalar / boolean / json), plus a
    // serial PK and a bigint, plus a UNIQUE and a CHECK to trip both constraint
    // classes.
    await client.query(`CREATE TABLE ${TABLE} (
      id serial PRIMARY KEY,
      big bigint,
      flag boolean NOT NULL,
      payload jsonb,
      doc json,
      name text,
      n integer,
      CONSTRAINT ${TABLE}_name_uq UNIQUE (name),
      CONSTRAINT ${TABLE}_n_positive CHECK (n > 0)
    )`)
  })

  afterAll(async () => {
    await client?.query(`DROP TABLE IF EXISTS ${TABLE}`)
    await client?.end()
  })

  it('connects and runs SELECT 1', async () => {
    const res = await client.query('SELECT 1 AS n')
    expect(res.rows[0].n).toBe(1)
  })

  it('INSERT … RETURNING * hands back the resolved row with per-kind JS types', async () => {
    const res = await client.query(
      `INSERT INTO ${TABLE} (big, flag, payload, doc, name, n)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      ['9007199254740993', true, { a: 1 }, { b: 2 }, 'alice', 5],
    )
    const row = res.rows[0]

    // serial / integer → JS number
    expect(typeof row.id).toBe('number')
    expect(typeof row.n).toBe('number')
    // boolean → NATIVE JS boolean (not 0/1, unlike sqlite)
    expect(row.flag).toBe(true)
    expect(typeof row.flag).toBe('boolean')
    // jsonb / json → already-parsed JS object (the driver parses for you; no
    // JSON.parse needed, unlike the sqlite text codec)
    expect(row.payload).toEqual({ a: 1 })
    expect(row.doc).toEqual({ b: 2 })
    expect(typeof row.payload).toBe('object')
    // bigint → JS *string*. The fact that bites: a bigint column does NOT come
    // back as a JS number/bigint. Callers must treat these as strings (or configure
    // a type parser) rather than assume numeric.
    expect(typeof row.big).toBe('string')
    expect(row.big).toBe('9007199254740993')
  })

  it('duplicate key → SQLSTATE 23505 with the violated constraint NAME on the error', async () => {
    // `alice` was inserted by the previous test; re-inserting the same name trips
    // the UNIQUE constraint.
    let err: any
    try {
      await client.query(`INSERT INTO ${TABLE} (flag, name, n) VALUES ($1, $2, $3)`, [false, 'alice', 1])
    } catch (e) {
      err = e
    }
    expect(err).toBeTruthy()
    // classify on SQLSTATE, not a message regex.
    expect(err.code).toBe('23505')
    // and the constraint NAME is present (pg exposes it as `.constraint`) — this is
    // what lets a caller map a violation back to the collection/column that caused it.
    expect(err.constraint).toBe(`${TABLE}_name_uq`)
  })

  it('CHECK violation → SQLSTATE 23514 with the constraint name', async () => {
    let err: any
    try {
      await client.query(`INSERT INTO ${TABLE} (flag, name, n) VALUES ($1, $2, $3)`, [false, 'bob', -1])
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('23514')
    expect(err.constraint).toBe(`${TABLE}_n_positive`)
  })

  it('NOT NULL violation → SQLSTATE 23502 with the offending column', async () => {
    let err: any
    try {
      // `flag` is NOT NULL and omitted
      await client.query(`INSERT INTO ${TABLE} (name, n) VALUES ($1, $2)`, ['carol', 1])
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('23502')
    // pg names the column on `.column` for not-null violations
    expect(err.column).toBe('flag')
  })

  it('transaction rollback: a violated statement leaves no rows behind', async () => {
    await client.query('BEGIN')
    await client.query(`INSERT INTO ${TABLE} (flag, name, n) VALUES ($1, $2, $3)`, [true, 'dave', 1])
    let err: any
    try {
      // collide on the UNIQUE name we just inserted in this same txn
      await client.query(`INSERT INTO ${TABLE} (flag, name, n) VALUES ($1, $2, $3)`, [true, 'dave', 2])
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('23505')
    await client.query('ROLLBACK')

    // after rollback, neither insert survived
    const res = await client.query(`SELECT count(*)::int AS c FROM ${TABLE} WHERE name = $1`, ['dave'])
    expect(res.rows[0].c).toBe(0)
  })
})
