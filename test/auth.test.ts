import { describe, it, expect } from 'vitest'
import { isAllowed, rejectionReason, rejectionStatus, bearer } from '../src/server/auth.ts'

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
