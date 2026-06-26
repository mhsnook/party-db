import { describe, it, expect } from 'vitest'
import { authHooks, isAllowed, rejectionReason, rejectionStatus, bearer, type AuthKind } from '../src/server/auth.ts'

describe('auth decision helpers', () => {
  it('reads the verdict from a bare boolean or the object form', () => {
    expect(isAllowed(true)).toBe(true)
    expect(isAllowed(false)).toBe(false)
    expect(isAllowed({ ok: true })).toBe(true)
    expect(isAllowed({ ok: false })).toBe(false)
  })

  it('defaults the rejection reason but honors a supplied one', () => {
    expect(rejectionReason(false)).toBe('unauthorized')
    expect(rejectionReason({ ok: false })).toBe('unauthorized')
    expect(rejectionReason({ ok: false, error: 'no session' })).toBe('no session')
  })

  it('defaults the POST status to 401 but honors a supplied one', () => {
    expect(rejectionStatus(false)).toBe(401)
    expect(rejectionStatus({ ok: false })).toBe(401)
    expect(rejectionStatus({ ok: false, status: 403 })).toBe(403)
  })
})

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
  const connect = (token?: string) =>
    new Request(`https://x/parties/main/r${token ? `?token=${token}` : ''}`, { headers: { Upgrade: 'websocket' } })
  const post = (token?: string) =>
    new Request('https://x/parties/main/r', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} })

  // gate on a token in either place; record which door was checked.
  const seen: AuthKind[] = []
  const authorize = (r: Request, kind: AuthKind) => {
    seen.push(kind)
    const token = bearer(r) ?? new URL(r.url).searchParams.get('token')
    return token === 'ok' ? true : { ok: false, status: 401, error: `no (${kind})` }
  }
  const hooks = authHooks(authorize)

  it('passes an authorized connect through (returns undefined)', async () => {
    expect(await hooks.onBeforeConnect(connect('ok'))).toBeUndefined()
    expect(seen.at(-1)).toBe('connect')
  })

  it('refuses an unauthorized connect with a plain Response (no body parsing)', async () => {
    const res = await hooks.onBeforeConnect(connect())
    expect(res?.status).toBe(401)
    expect(await res!.text()).toBe('no (connect)')
  })

  it('passes an authorized POST through', async () => {
    expect(await hooks.onBeforeRequest(post('ok'))).toBeUndefined()
    expect(seen.at(-1)).toBe('write')
  })

  it('refuses an unauthorized POST with a WriteReject JSON body', async () => {
    const res = await hooks.onBeforeRequest(post())
    expect(res?.status).toBe(401)
    expect(await res!.json()).toEqual({ error: 'no (write)' })
  })

  it('does not auth-check non-POST requests (they fall through to the DO)', async () => {
    const get = new Request('https://x/parties/main/r', { method: 'GET' })
    const before = seen.length
    expect(await hooks.onBeforeRequest(get)).toBeUndefined()
    expect(seen.length).toBe(before) // authorize never ran
  })
})
