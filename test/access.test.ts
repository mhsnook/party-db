// The access policies (cookbook 5), as pure functions: the shorthands, the boot
// checks, the read filter, the fan-out split, and the write gate. The core wires
// these into the four choke points; test/access-core.test.ts drives them there.

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  accessOf,
  AccessDenied,
  ANONYMOUS,
  applyPriorRows,
  audiencesOf,
  audienceTag,
  checkAccess,
  gateWrite,
  needsPriorRow,
  opFor,
  policiesOf,
  storedKeysNeeded,
  uidOf,
  viewerFromTags,
  viewerTags,
  visibleTo,
} from '../src/server/access.ts'
import { definePartyCollection, type PartyCollection } from '../src/schema.ts'
import type { SequencedBatch, WriteBatch, WriteEvent } from '../src/protocol.ts'

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
  // `ownerColumn` is typed `UidColumn<T>`, so a TS app with a schema is stopped at
  // the declaration. These are the cases the type cannot reach: a cast, plain JS,
  // or a collection with no schema to infer from.
  const loose = (cfg: Record<string, unknown>) => cfg as unknown as PartyCollection<any>

  it('refuses an owner policy with no ownerColumn', () => {
    expect(() => checkAccess(definePartyCollection({ name: 't', key: 'id', schema, access: 'owner' }))).toThrow(/no ownerColumn/)
  })

  it('refuses an ownerColumn the schema does not declare', () => {
    expect(() => checkAccess(loose({ name: 'cards', key: 'id', schema, ownerColumn: 'nope' }))).toThrow(/does not declare/)
  })

  it('refuses an ownerColumn the schema types as anything but a string', () => {
    const numeric = z.object({ id: z.string(), user_id: z.number(), text: z.string() })
    expect(() => checkAccess(loose({ name: 'cards', key: 'id', schema: numeric, ownerColumn: 'user_id' }))).toThrow(/types as number/)
  })

  it('accepts every Zod string subtype, so a uuid or email uid is not refused', () => {
    for (const uid of [z.uuid(), z.email(), z.string().nullable(), z.string().optional(), z.iso.datetime()]) {
      const s = z.object({ id: z.string(), user_id: uid, text: z.string() })
      expect(() => checkAccess(loose({ name: 'cards', key: 'id', schema: s, ownerColumn: 'user_id' }))).not.toThrow()
    }
  })

  it('accepts an ownerColumn on a schema-less collection, which has no declared columns', () => {
    expect(() => checkAccess(loose({ name: 'cards', key: 'id', ownerColumn: 'user_id' }))).not.toThrow()
  })
})

describe('reads — visibleTo and audiencesOf', () => {
  const mixed = batch('cards', [ins({ id: '1', user_id: 'alice', text: 'a' }), ins({ id: '2', user_id: 'bob', text: 'b' })])

  it('passes a public batch through untouched', () => {
    const b = batch('phrases', [ins({ id: 'p', text: 'hola' })])
    expect(visibleTo(accessByChannel.get('phrases')!, b, ANONYMOUS)).toBe(b)
  })

  it("keeps only the viewer's own rows under an owner read", () => {
    expect(visibleTo(accessByChannel.get('cards')!, mixed, alice)?.ops.map((o) => o.value)).toEqual([
      { id: '1', user_id: 'alice', text: 'a' },
    ])
  })

  it('drops a delta with nothing visible, but keeps an empty snapshot so the collection still turns ready', () => {
    expect(visibleTo(accessByChannel.get('cards')!, mixed, ANONYMOUS)).toBeNull()
    const snapshot = { ...mixed, reset: true, ready: true }
    expect(visibleTo(accessByChannel.get('cards')!, snapshot, ANONYMOUS)).toMatchObject({ ops: [], reset: true, ready: true })
  })

  it('fans a public batch out once, to everyone', () => {
    const b = batch('phrases', [ins({ id: 'p', text: 'hola' })])
    expect(audiencesOf(accessByChannel.get('phrases')!, b)).toEqual([{ audience: 'all', batch: b }])
  })

  it('fans an owner batch out per owner, and a row with no owner to no one', () => {
    const withOrphan = batch('cards', [...mixed.ops, ins({ id: '3', text: 'orphan' })])
    const out = audiencesOf(accessByChannel.get('cards')!, withOrphan)
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
      return e instanceof AccessDenied ? e.rejection.status : e
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

describe('writes — the prior-row read', () => {
  const stored = new Map([['cards', new Map([['1', { id: '1', user_id: 'bob', text: 'b' }]])]])

  it('asks for the stored rows of updates and deletes only', () => {
    const body: WriteBatch[] = [
      { channel: 'cards', ops: [ins({ id: '0', text: 'x' }), { type: 'update', value: { id: '1' } }, { type: 'delete', value: { id: '2' } }] },
      { channel: 'phrases', ops: [ins({ id: 'p', text: 'hola' })] },
    ]
    expect(storedKeysNeeded(accessByChannel, body)).toEqual(new Map([['cards', ['1', '2']]]))
  })

  it("refuses an update or delete of someone else's row", () => {
    for (const type of ['update', 'delete'] as const) {
      expect(() => applyPriorRows(accessByChannel, [{ channel: 'cards', ops: [{ type, value: { id: '1' } }] }], stored, alice)).toThrow(
        AccessDenied,
      )
    }
  })

  it('stamps an update with the stored row, so the fan-out knows who held it before', () => {
    const mine = new Map([['cards', new Map([['1', { id: '1', user_id: 'alice', text: 'a' }]])]])
    const body: WriteBatch[] = [{ channel: 'cards', ops: [{ type: 'update', value: { id: '1', text: 'b' } }] }]
    expect(applyPriorRows(accessByChannel, body, mine, alice)[0].ops[0].previousValue).toEqual({ id: '1', user_id: 'alice', text: 'a' })
  })

  it('reads the prior row for a host write too, which is authorized but still has to route', () => {
    const mine = new Map([['cards', new Map([['1', { id: '1', user_id: 'bob', text: 'b' }]])]])
    const body: WriteBatch[] = [{ channel: 'cards', ops: [{ type: 'update', value: { id: '1', user_id: 'alice' } }] }]
    // no viewer: bob's row is not refused, and the op still carries who held it
    expect(applyPriorRows(accessByChannel, body, mine)[0].ops[0].previousValue).toEqual({ id: '1', user_id: 'bob', text: 'b' })
  })

  it('rewrites a delete to carry the stored row, so it routes by the real owner', () => {
    const mine = new Map([['cards', new Map([['1', { id: '1', user_id: 'alice', text: 'a' }]])]])
    const [b] = applyPriorRows(accessByChannel, [{ channel: 'cards', ops: [{ type: 'delete', value: { id: '1', user_id: 'mallory' } }] }], mine, alice)
    expect(b.ops[0].value).toEqual({ id: '1', user_id: 'alice', text: 'a' })
  })

  it("lets a missing row through: an update is the adapter's missing-row rejection, a delete deletes nothing", () => {
    const none = new Map([['cards', new Map()]])
    const [b] = applyPriorRows(accessByChannel, [{ channel: 'cards', ops: [{ type: 'delete', value: { id: '9', user_id: 'bob' } }] }], none, alice)
    expect(b.ops[0].value).toEqual({ id: '9', user_id: 'alice' })
  })
})

// A row leaves a viewer's reach when its owner column is reassigned. Nothing in
// the post-image says so, so these cover the prior row doing that job — at the
// fan-out, and again on the `?since` replay that reads the same ops back out of
// the `_oplog`.
describe('reads — a row that changes hands', () => {
  const access = accessOf(cards)
  const moved: WriteEvent = {
    type: 'update',
    value: { id: '1', user_id: 'bob', text: 'a' },
    previousValue: { id: '1', user_id: 'alice', text: 'a' },
  }

  it('tells the losing owner it is gone, and the gaining owner it is new', () => {
    expect(opFor(access, moved, alice)).toEqual({ type: 'delete', value: { id: '1', user_id: 'alice', text: 'a' } })
    expect(opFor(access, moved, { uid: 'bob' })).toEqual({ type: 'insert', value: { id: '1', user_id: 'bob', text: 'a' } })
    expect(opFor(access, moved, { uid: 'carol' })).toBeNull()
  })

  it('does not name the former owner in what the new owner receives', () => {
    expect(opFor(access, moved, { uid: 'bob' })).not.toHaveProperty('previousValue')
  })

  it('fans one committed batch out to both of them', () => {
    const out = audiencesOf(access, batch('cards', [moved]))
    expect(out.map((o) => [o.audience, o.batch.ops.map((op) => op.type)])).toEqual([
      [{ uid: 'bob' }, ['insert']],
      [{ uid: 'alice' }, ['delete']],
    ])
  })

  it('replays the same way out of the backlog, so a reconnect corrects a missed hand-off', () => {
    const delta = batch('cards', [moved])
    expect(visibleTo(access, delta, alice)?.ops).toEqual([{ type: 'delete', value: { id: '1', user_id: 'alice', text: 'a' } }])
    expect(visibleTo(access, delta, { uid: 'bob' })?.ops).toEqual([{ type: 'insert', value: { id: '1', user_id: 'bob', text: 'a' } }])
  })

  it('leaves an ordinary same-owner update as an update', () => {
    const edited: WriteEvent = {
      type: 'update',
      value: { id: '1', user_id: 'alice', text: 'b' },
      previousValue: { id: '1', user_id: 'alice', text: 'a' },
    }
    expect(opFor(access, edited, alice)).toBe(edited)
  })
})

describe('needsPriorRow — why the row is read', () => {
  it('reads it to authorize an owner update or delete', () => {
    const write = accessOf(definePartyCollection({ name: 'c', key: 'id', schema, ownerColumn: 'user_id', access: { read: 'public', update: 'owner', delete: 'owner' } }))
    expect(needsPriorRow(write, { type: 'update', value: {} })).toBe(true)
    expect(needsPriorRow(write, { type: 'insert', value: {} })).toBe(false)
  })

  it('reads it to ROUTE an owner read, even where the verb itself needs no check', () => {
    // delete is 'authed' here, so the payload's owner column is unchecked — and it
    // is exactly what the fan-out would route by if the stored row were not read.
    const route = accessOf(
      definePartyCollection({ name: 'c', key: 'id', schema, ownerColumn: 'user_id', access: { read: 'owner', insert: 'owner', update: 'owner', delete: 'authed' } }),
    )
    expect(needsPriorRow(route, { type: 'delete', value: {} })).toBe(true)
  })

  it('needs nothing for a collection with no owner anywhere', () => {
    const open = accessOf(definePartyCollection({ name: 'todos', key: 'id', schema }))
    expect(needsPriorRow(open, { type: 'delete', value: {} })).toBe(false)
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
