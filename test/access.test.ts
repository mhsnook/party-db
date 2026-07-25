// The access guard (issue #33): declaring `access`/`ownerColumn` today enforces
// nothing, so the server must at least WARN loudly rather than let a
// security-shaped config pass in silence. Pre-alpha stance — warn, don't throw.

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { unenforcedAccessCollections, warnUnenforcedAccess } from '../src/server/access.ts'
import { definePartyCollection } from '../src/schema.ts'

const schema = z.object({ id: z.string(), user_id: z.string() })

describe('access guard — unenforced-policy detection', () => {
  it('flags exactly the collections that declare access or ownerColumn', () => {
    const cols = [
      definePartyCollection({ name: 'plain', key: 'id', schema }),
      definePartyCollection({ name: 'owned', key: 'id', schema, ownerColumn: 'user_id' }),
      definePartyCollection({ name: 'ruled', key: 'id', schema, access: 'owner' }),
    ]
    expect(unenforcedAccessCollections(cols)).toEqual(['owned', 'ruled'])
  })
})

describe('access guard — startup warning', () => {
  it('warns once, naming the offenders and saying it is not enforced', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnUnenforcedAccess([
      definePartyCollection({ name: 'owned', key: 'id', schema, ownerColumn: 'user_id' }),
      definePartyCollection({ name: 'ruled', key: 'id', schema, access: { read: 'owner' } }),
    ])
    expect(warn).toHaveBeenCalledOnce()
    const msg = warn.mock.calls[0][0] as string
    expect(msg).toMatch(/owned/)
    expect(msg).toMatch(/ruled/)
    expect(msg).toMatch(/NOT implemented|do NOTHING|not enforced|security/i)
    warn.mockRestore()
  })

  it('stays silent when no collection declares a policy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnUnenforcedAccess([definePartyCollection({ name: 'plain', key: 'id', schema })])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
