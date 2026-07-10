// Can a Durable Object under @cloudflare/vitest-pool-workers open a TCP connection
// to a real Postgres? The fixture worker's `/__pg-probe` endpoint connects with
// `pg` (node-postgres, over `cloudflare:sockets` via nodejs_compat), runs SELECT 1
// and one parameterized INSERT … RETURNING, and reports the resolved JS types so
// we can confirm workerd matches the node lane. Skips when PG_URL is unset, same
// as the node lane, so plain integration runs never need a Postgres.
import { describe, it, expect } from 'vitest'
import { env, SELF } from 'cloudflare:test'

const PG_URL = (env as { PG_URL?: string }).PG_URL

describe.skipIf(!PG_URL)('workerd → Postgres connectivity', () => {
  it('opens a TCP connection from a worker and round-trips a row', async () => {
    const res = await SELF.fetch('https://example.com/__pg-probe')
    const body = (await res.json()) as any
    expect(body, JSON.stringify(body)).toMatchObject({ ok: true, select1: 1 })
    expect(body.types.flag).toBe('boolean')
    expect(body.types.big).toBe('string')
  })
})
