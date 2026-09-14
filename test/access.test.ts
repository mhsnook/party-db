// The access policies (cookbook 5), as pure functions: the shorthands, the boot
// checks, the read filter, the fan-out split, and the write gate. The core wires
// these into the four choke points; test/access-core.test.ts drives them there.

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  accessOf,
  AccessDenied,
  ANONYMOUS,
  audiencesOf,
  audienceTag,
  checkAccess,
  checkStored,
  gateWrite,
  policiesOf,
  storedKeysNeeded,
  uidOf,
  viewerFromTags,
  viewerTags,
  visibleTo,
} from '../src/server/access.ts'
import { definePartyCollection } from '../src/schema.ts'
import type { SequencedBatch, WriteBatch } from '../src/protocol.ts'

const schema = z.object({ id: z.string(), user_id: z.string().optional(), text: z.string() })
const cards = definePartyCollection({ name: 'cards', key: 'id', schema, ownerColumn: 'user_id' })
const phrases = definePartyCollection({ name: 'phrases', key: 'id', schema, access: { read: 'public', insert: 'authed' } })
const accessByChannel = new Map([cards, phrases].map((c) => [c.name, accessOf(c)]))

const alice = { uid: 'alice' }
const batch = (channel: string, ops: SequencedBatch['ops'], extra: Partial<SequencedBatch> = {}): SequencedBatch => ({
  channel,
  seq: 7,
  ops,
  ...extra,
})
const ins = (value: Record<string, unknown>) => ({ type: 'insert' as const, value })

describe('policiesOf — the shorthands', () => {
  it('reads a collection with no declaration as public on every verb', () => {
    expect(policiesOf(definePartyCollection({ name: 'todos', key: 'id', schema }))).toEqual({
      read: 'public',
      insert: 'public',
      update: 'public',
      delete: 'public',
    })
  })

  it('reads a bare ownerColumn as owner on every verb', () => {
    expect(policiesOf(cards)).toEqual({ read: 'owner', insert: 'owner', update: 'owner', delete: 'owner' })
  })

  it('applies a single policy to every verb', () => {
    expect(Object.values(policiesOf(definePartyCollection({ name: 't', key: 'id', schema, access: 'authed' })))).toEqual([
      'authed',
      'authed',
      'authed',
      'authed',
    ])
  })

  it('denies every verb the object form does not name', () => {
    expect(policiesOf(phrases)).toEqual({ read: 'public', insert: 'authed', update: 'none', delete: 'none' })
  })
})

describe('checkAccess — what cannot be enforced refuses to start', () => {
  it('refuses an owner policy with no ownerColumn', () => {
    expect(() => checkAccess(definePartyCollection({ name: 't', key: 'id', schema, access: 'owner' }), ['id'])).toThrow(/no ownerColumn/)
  })

  it('refuses an ownerColumn the schema does not declare', () => {
    expect(() => checkAccess(cards, ['id', 'text'])).toThrow(/does not declare/)
  })

  it('accepts an ownerColumn on a schema-less collection, which has no fixed columns', () => {
    expect(() => checkAccess(cards, null)).not.toThrow()
  })
})

describe('reads — visibleTo and audiencesOf', () => {
  const mixed = batch('cards', [ins({ id: '1', user_id: 'alice', text: 'a' }), ins({ id: '2', user_id: 'bob', text: 'b' })])

  it('passes a public batch through untouched', () => {
    const b = batch('phrases', [ins({ id: 'p', text: 'hola' })])
    expect(visibleTo(accessByChannel.get('phrases'), b, ANONYMOUS)).toBe(b)
  })

  it("keeps only the viewer's own rows under an owner read", () => {
    expect(visibleTo(accessByChannel.get('cards'), mixed, alice)?.ops.map((o) => o.value)).toEqual([
      { id: '1', user_id: 'alice', text: 'a' },
    ])
  })

  it('drops a delta with nothing visible, but keeps an empty snapshot so the collection still turns ready', () => {
    expect(visibleTo(accessByChannel.get('cards'), mixed, ANONYMOUS)).toBeNull()
    const snapshot = { ...mixed, reset: true, ready: true }
    expect(visibleTo(accessByChannel.get('cards'), snapshot, ANONYMOUS)).toMatchObject({ ops: [], reset: true, ready: true })
  })

  it('fans a public batch out once, to everyone', () => {
    const b = batch('phrases', [ins({ id: 'p', text: 'hola' })])
    expect(audiencesOf(accessByChannel.get('phrases'), b)).toEqual([{ audience: 'all', batch: b }])
  })

  it('fans an owner batch out per owner, and a row with no owner to no one', () => {
    const withOrphan = batch('cards', [...mixed.ops, ins({ id: '3', text: 'orphan' })])
    const out = audiencesOf(accessByChannel.get('cards'), withOrphan)
    expect(out.map((o) => [o.audience, o.batch.ops.map((op) => (op.value as { id: string }).id)])).toEqual([
      [{ uid: 'alice' }, ['1']],
      [{ uid: 'bob' }, ['2']],
    ])
    expect(out.every((o) => o.batch.seq === 7)).toBe(true)
  })

  it("sends an 'authed' read to signed-in sockets and a 'none' read to nobody", () => {
    const authed = accessOf(definePartyCollection({ name: 'a', key: 'id', schema, access: { read: 'authed' } }))
    const none = accessOf(definePartyCollection({ name: 'n', key: 'id', schema, access: { insert: 'public' } }))
    expect(audiencesOf(authed, mixed)[0].audience).toBe('authed')
    expect(audiencesOf(none, mixed)).toEqual([])
  })
})

describe('writes — gateWrite', () => {
  const write = (channel: string, op: WriteBatch['ops'][number]): WriteBatch[] => [{ channel, ops: [op] }]
  const denied = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      return e instanceof AccessDenied ? e.status : e
    }
    return 'allowed'
  }

  it("stamps the owner column on an owner insert that omits it", () => {
    const [b] = gateWrite(accessByChannel, write('cards', ins({ id: '1', text: 'a' })), alice)
    expect(b.ops[0].value).toEqual({ id: '1', text: 'a', user_id: 'alice' })
  })

  it('refuses a forged owner on insert, and a reassigned owner on update', () => {
    expect(denied(() => gateWrite(accessByChannel, write('cards', ins({ id: '1', user_id: 'bob', text: 'a' })), alice))).toBe(403)
    const reassign = { type: 'update' as const, value: { id: '1', user_id: 'bob' } }
    expect(denied(() => gateWrite(accessByChannel, write('cards', reassign), alice))).toBe(403)
  })

  it('refuses an anonymous writer where the verb needs a user', () => {
    expect(denied(() => gateWrite(accessByChannel, write('cards', ins({ id: '1', text: 'a' })), ANONYMOUS))).toBe(401)
    expect(denied(() => gateWrite(accessByChannel, write('phrases', ins({ id: 'p', text: 'hola' })), ANONYMOUS))).toBe(401)
  })

  it("refuses a 'none' verb to everyone", () => {
    const edit = { type: 'update' as const, value: { id: 'p', text: 'adios' } }
    expect(denied(() => gateWrite(accessByChannel, write('phrases', edit), alice))).toBe(403)
  })

  it('leaves an open collection’s batch untouched', () => {
    const open = new Map([['todos', accessOf(definePartyCollection({ name: 'todos', key: 'id', schema }))]])
    const body = write('todos', ins({ id: '1', text: 'a' }))
    expect(gateWrite(open, body, ANONYMOUS)[0]).toBe(body[0])
  })
})

describe('writes — the stored-row check', () => {
  const stored = new Map([['cards', new Map([['1', { id: '1', user_id: 'bob', text: 'b' }]])]])

  it('asks for the stored rows of owner updates and deletes only', () => {
    const body: WriteBatch[] = [
      { channel: 'cards', ops: [ins({ id: '0', text: 'x' }), { type: 'update', value: { id: '1' } }, { type: 'delete', value: { id: '2' } }] },
      { channel: 'phrases', ops: [ins({ id: 'p', text: 'hola' })] },
    ]
    expect(storedKeysNeeded(accessByChannel, body)).toEqual(new Map([['cards', ['1', '2']]]))
  })

  it("refuses an update or delete of someone else's row", () => {
    for (const type of ['update', 'delete'] as const) {
      expect(() => checkStored(accessByChannel, [{ channel: 'cards', ops: [{ type, value: { id: '1' } }] }], stored, alice)).toThrow(
        AccessDenied,
      )
    }
  })

  it('rewrites a delete to carry the stored row, so it routes by the real owner', () => {
    const mine = new Map([['cards', new Map([['1', { id: '1', user_id: 'alice', text: 'a' }]])]])
    const [b] = checkStored(accessByChannel, [{ channel: 'cards', ops: [{ type: 'delete', value: { id: '1', user_id: 'mallory' } }] }], mine, alice)
    expect(b.ops[0].value).toEqual({ id: '1', user_id: 'alice', text: 'a' })
  })

  it("lets a missing row through: an update is the adapter's missing-row rejection, a delete deletes nothing", () => {
    const none = new Map([['cards', new Map()]])
    const [b] = checkStored(accessByChannel, [{ channel: 'cards', ops: [{ type: 'delete', value: { id: '9', user_id: 'bob' } }] }], none, alice)
    expect(b.ops[0].value).toEqual({ id: '9', user_id: 'alice' })
  })
})

describe('identity — uidOf and the socket tags', () => {
  it('reads the uid from the verified claims’ sub', () => {
    expect(uidOf({ claims: { sub: 'alice' } })).toBe('alice')
    expect(uidOf({ role: 'anon' })).toBeNull()
    expect(uidOf(null)).toBeNull()
  })

  it('pins a viewer to tags and reads it back', () => {
    expect(viewerFromTags(['conn-1', ...viewerTags(alice)])).toEqual(alice)
    expect(viewerFromTags(['conn-1'])).toEqual(ANONYMOUS)
    expect(viewerTags(ANONYMOUS)).toEqual([])
    expect(viewerTags(alice)).toContain(audienceTag({ uid: 'alice' }))
    expect(viewerTags(alice)).toContain(audienceTag('authed'))
  })

  it('reads a uid too long for a tag as anonymous, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(viewerTags({ uid: 'x'.repeat(300) })).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
