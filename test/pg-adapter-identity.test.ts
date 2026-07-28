// Identity injection — the mechanics, pinned WITHOUT a real Postgres so they run
// on every `pnpm test`: a recording PgClient captures the exact statements the
// adapter emits so we can prove (1) the verified claims/role are injected via a
// PARAMETERIZED `set_config(name, value, is_local => true)` — never string-built
// into SQL — (2) issued at the TOP of the transaction, after BEGIN and before any
// data statement, and (3) omitted entirely when no identity is passed (so the
// no-`auth` path is byte-identical to before this feature). The end-to-end proof
// that Postgres' RLS actually ENFORCES the injected identity lives in the pg lane
// (test/pg/pg-rls.test.ts), where a real database is cheap.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { PgAdapter, type PgClient } from '../src/server/pg-adapter.ts'
import { definePartyCollection } from '../src/schema.ts'
import type { WriteBatch } from '../src/protocol.ts'

const docs = definePartyCollection({
  name: 'docs',
  key: 'id',
  schema: z.object({ id: z.string(), owner: z.string().optional(), body: z.string() }),
})

// A PgClient that records every (text, values) and returns just enough for the
// adapter's write path to complete: a resolved row for the app-table RETURNING,
// a seq for the oplog insert, empty otherwise.
function recorder() {
  const calls: { text: string; values?: unknown[] }[] = []
  const client: PgClient = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values })
      if (/INSERT INTO _oplog/.test(text)) return { rows: [{ seq: 1 }] as any[] }
      if (/RETURNING \*/.test(text)) return { rows: [{ id: 'a', owner: 'alice', body: 'x' }] as any[] }
      return { rows: [] as any[] }
    },
  }
  return { calls, client }
}

const ins: WriteBatch = { channel: 'docs', ops: [{ type: 'insert', value: { id: 'a', body: 'x' } }] }
const setConfigs = (calls: { text: string; values?: unknown[] }[]) => calls.filter((c) => /set_config/.test(c.text))

describe('PgAdapter identity injection (recording client)', () => {
  it('injects claims via a parameterized set_config(..., is_local=true), after BEGIN, before the write', async () => {
    const { calls, client } = recorder()
    const adapter = new PgAdapter(() => Promise.resolve(client), [docs])
    await adapter.write([ins], { claims: { sub: 'alice', org: 'acme' } })

    const idx = (re: RegExp) => calls.findIndex((c) => re.test(c.text))
    // ordering: BEGIN → set_config → the app-table insert
    expect(idx(/^BEGIN$/)).toBeGreaterThanOrEqual(0)
    expect(idx(/set_config/)).toBeGreaterThan(idx(/^BEGIN$/))
    expect(idx(/INSERT INTO "docs"/)).toBeGreaterThan(idx(/set_config/))

    // parameterized, transaction-local, carrying the claims as JSON
    const [claims] = setConfigs(calls)
    expect(claims.text).toBe('SELECT set_config($1, $2, true)')
    expect(claims.values).toEqual(['request.jwt.claims', JSON.stringify({ sub: 'alice', org: 'acme' })])
  })

  it('injects claims and role together in ONE round-trip (claims bound before role)', async () => {
    const { calls, client } = recorder()
    const adapter = new PgAdapter(() => Promise.resolve(client), [docs])
    await adapter.write([ins], { claims: { sub: 'alice' }, role: 'app_user' })

    // a single set_config statement carries both settings — not two round-trips
    const cfg = setConfigs(calls)
    expect(cfg).toHaveLength(1)
    expect(cfg[0].text).toBe('SELECT set_config($1, $2, true), set_config($3, $4, true)')
    expect(cfg[0].values).toEqual(['request.jwt.claims', JSON.stringify({ sub: 'alice' }), 'role', 'app_user'])
  })

  it('injects only the role when no claims are given', async () => {
    const { calls, client } = recorder()
    const adapter = new PgAdapter(() => Promise.resolve(client), [docs])
    await adapter.write([ins], { role: 'tenant_42' })

    const cfg = setConfigs(calls)
    expect(cfg).toHaveLength(1)
    expect(cfg[0].values).toEqual(['role', 'tenant_42'])
  })

  it('injects NOTHING when no identity is passed — the no-auth path is unchanged', async () => {
    const { calls, client } = recorder()
    const adapter = new PgAdapter(() => Promise.resolve(client), [docs])
    await adapter.write([ins])
    expect(setConfigs(calls)).toHaveLength(0)
    await adapter.write([ins], undefined)
    expect(setConfigs(calls)).toHaveLength(0)
  })
})

describe('PgAdapter classifyError — RLS/permission denial → 403', () => {
  const adapter = new PgAdapter(() => Promise.reject(new Error('unused')), [docs])
  // pg delivers errors as Error instances with SQLSTATE on `.code` and the
  // constraint on `.constraint` — mirror that shape.
  const pgErr = (props: Record<string, unknown> & { message: string }) => Object.assign(new Error(props.message), props)

  it('maps SQLSTATE 42501 (insufficient_privilege) to a 403-status rejection', () => {
    const rej = adapter.classifyError(pgErr({ code: '42501', message: 'new row violates row-level security policy for table "docs"' }))
    expect(rej).not.toBeNull()
    expect(rej!.status).toBe(403)
    expect(rej!.error).toMatch(/row-level security/i)
    expect(rej!.constraint).toBeUndefined() // an authorization denial names no constraint
  })

  it('leaves the 23-class integrity path a 409 (no status) carrying the constraint name', () => {
    const rej = adapter.classifyError(pgErr({ code: '23505', message: 'duplicate key', constraint: 'docs_pkey' }))
    expect(rej).toEqual({ error: 'duplicate key', constraint: 'docs_pkey' })
    expect(rej!.status).toBeUndefined() // defaults to 409 at the server
  })

  it('returns null for a non-constraint, non-privilege error (→ server 500)', () => {
    expect(adapter.classifyError(pgErr({ code: '42P01', message: 'relation does not exist' }))).toBeNull() // undefined_table
    expect(adapter.classifyError(new Error('boom'))).toBeNull()
  })
})
