import { describe, it, expect } from 'vitest'
import { authHooks, bearer, type AuthContext } from '../src/server/auth.ts'

describe('bearer', () => {
  const req = (auth?: string) => new Request('https://x', auth ? { headers: { authorization: auth } } : undefined)

  it('extracts a bearer token, case-insensitively on the scheme', () => {
    expect(bearer(req('Bearer abc123'))).toBe('abc123')
    expect(bearer(req('bearer abc123'))).toBe('abc123')
  })

  it('returns null when absent or not a bearer header', () => {
    expect(bearer(req())).toBeNull()
    expect(bearer(req('Basic abc123'))).toBeNull()
  })
})

describe('authHooks', () => {
  const lobby = { className: 'Main', name: 'r' }
  const connect = (token?: string) =>
    new Request(`https://x/parties/main/r${token ? `?token=${token}` : ''}`, { headers: { Upgrade: 'websocket' } })
  const post = (token?: string) =>
    new Request('https://x/parties/main/r', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} })

  // gate on a token in either place; record the context each door was checked with.
  const seen: AuthContext[] = []
  const authorize = (r: Request, ctx: AuthContext) => {
    seen.push(ctx)
    const token = bearer(r) ?? new URL(r.url).searchParams.get('token')
    return token === 'ok' ? true : { ok: false, status: 401, error: `no (${ctx.kind})` }
  }
  const hooks = authHooks(authorize)

  it('passes an authorized connect through, forwarding the resolved party/room', async () => {
    expect(await hooks.onBeforeConnect(connect('ok'), lobby)).toBeUndefined()
    expect(seen.at(-1)).toEqual({ kind: 'connect', party: 'Main', room: 'r' })
  })

  it('refuses an unauthorized connect with a plain Response (no body parsing)', async () => {
    const res = await hooks.onBeforeConnect(connect(), lobby)
    expect(res?.status).toBe(401)
    expect(await res!.text()).toBe('no (connect)')
  })

  it('passes an authorized POST through', async () => {
    expect(await hooks.onBeforeRequest(post('ok'), lobby)).toBeUndefined()
    expect(seen.at(-1)?.kind).toBe('write')
  })

  it('refuses an unauthorized POST with a WriteReject JSON body', async () => {
    const res = await hooks.onBeforeRequest(post(), lobby)
    expect(res?.status).toBe(401)
    expect(await res!.json()).toEqual({ error: 'no (write)' })
  })

  it('does not auth-check non-POST requests (they fall through to the DO)', async () => {
    const before = seen.length
    expect(await hooks.onBeforeRequest(new Request('https://x/parties/main/r'), lobby)).toBeUndefined()
    expect(seen.length).toBe(before)
  })

  it('normalizes the decision shapes: bare false → 401/unauthorized, status override honored', async () => {
    const deny401 = authHooks(() => false)
    const r1 = await deny401.onBeforeConnect(connect(), lobby)
    expect([r1?.status, await r1!.text()]).toEqual([401, 'unauthorized'])

    const deny403 = authHooks(() => ({ ok: false, status: 403 }))
    const r2 = await deny403.onBeforeRequest(post(), lobby)
    expect([r2?.status, await r2!.json()]).toEqual([403, { error: 'unauthorized' }])
  })
})
