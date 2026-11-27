// Role grants as pure functions: the declaration checks, the read filter, the
// fan-out split, the write gate, and the role tags. test/access-roles-core.test.ts
// drives the same rules through the core.

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  accessOf,
  AccessDenied,
  ANONYMOUS,
  applyPriorRows,
  assertConnectionId,
  audiencesOf,
  audienceTag,
  canRead,
  checkAccess,
  gateWrite,
  MAX_ROLE_TAGS,
  needsPriorRow,
  readersOf,
  rolesNamed,
  viewerFromTags,
  viewerOf,
  viewerTags,
  visibleTo,
  type CollectionAccess,
  type Viewer,
} from '../src/server/access.ts'
import { definePartyCollection, type PartyCollection } from '../src/schema.ts'
import type { SequencedBatch, WriteBatch, WriteEvent } from '../src/protocol.ts'

const reviewSchema = z.object({ id: z.string(), reviewed_by: z.string().optional(), text: z.string() })
const draftSchema = z.object({ id: z.string(), text: z.string() })

// Sporelight's two shapes: public reviews that their author or an editor edits,
// and drafts only editors touch.
const reviews = definePartyCollection({
  name: 'reviews',
  key: 'id',
  schema: reviewSchema,
  ownerColumn: 'reviewed_by',
  access: { read: 'public', insert: 'owner', update: { owner: true, roles: ['editor'] }, delete: { owner: true, roles: ['editor'] } },
})
const drafts = definePartyCollection({ name: 'drafts', key: 'id', schema: draftSchema, access: { roles: ['editor'] } })
const notes = definePartyCollection({
  name: 'notes',
  key: 'id',
  schema: reviewSchema,
  ownerColumn: 'reviewed_by',
  access: { owner: true, roles: ['editor'] },
})
const byChannel = new Map<string, CollectionAccess>([reviews, drafts, notes].map((c) => [c.name, accessOf(c)]))
const access = (name: string) => byChannel.get(name)!

const alice: Viewer = { uid: 'alice', roles: [] }
const bob: Viewer = { uid: 'bob', roles: [] }
const carol: Viewer = { uid: 'carol', roles: ['editor'] }
const viewers = { anonymous: ANONYMOUS, 'a uid without the role': bob, 'a uid with the role': carol, 'the row owner': alice }

const batch = (channel: string, ops: WriteEvent[], extra: Partial<SequencedBatch> = {}): SequencedBatch => ({ channel, seq: 3, ops, ...extra })
const ins = (value: Record<string, unknown>): WriteEvent => ({ type: 'insert', value })
const write = (channel: string, op: WriteEvent): WriteBatch[] => [{ channel, ops: [op] }]
const statusOf = (fn: () => unknown): number | 'ok' => {
  try {
    fn()
    return 'ok'
  } catch (e) {
    if (e instanceof AccessDenied) return e.rejection.status!
    throw e
  }
}

describe('checkAccess — a grant that cannot mean what it says refuses to start', () => {
  const declare = (access: unknown, extra: Partial<Record<keyof PartyCollection<any>, unknown>> = {}) => () =>
    checkAccess({ name: 'r', key: 'id', schema: reviewSchema, ownerColumn: 'reviewed_by', access, ...extra } as PartyCollection<any>)

  it('accepts a grant per verb and a single grant for every verb', () => {
    expect(declare({ read: 'public', update: { owner: true, roles: ['editor'] } })).not.toThrow()
    expect(declare({ roles: ['editor', 'admin'] })).not.toThrow()
  })

  it("refuses Sporelight's draft { role: 'editor' }, which is not a grant", () => {
    expect(declare({ update: { role: 'editor' } })).toThrow(/names "role" in a grant/)
    expect(declare({ role: 'editor' })).toThrow(/names "role" in access/)
  })

  it('refuses a grant nobody can meet, and owner set to anything but true', () => {
    expect(declare({ update: {} })).toThrow(/nobody can meet/)
    expect(declare({ update: { roles: [] } })).toThrow(/nobody can meet/)
    expect(declare({ update: { owner: false, roles: ['editor'] } })).toThrow(/sets owner to false/)
  })

  it('refuses roles that are not non-empty strings, or too long to pin to a socket', () => {
    expect(declare({ update: { roles: 'editor' } })).toThrow(/not a list/)
    expect(declare({ update: { roles: [''] } })).toThrow(/not a list/)
    expect(declare({ update: { roles: ['x'.repeat(250)] } })).toThrow(/too long/)
  })

  it('refuses a grant and per-verb keys mixed in one object', () => {
    expect(declare({ read: 'public', roles: ['editor'] })).toThrow(/names "read" in a grant/)
  })

  it('refuses a policy string it does not know, and a value that is neither a policy nor a grant', () => {
    expect(declare({ update: 'owners' })).toThrow(/access.update is "owners"/)
    expect(declare('Public')).toThrow(/access is "Public"/)
    expect(declare({ read: true })).toThrow(/access.read is not a policy or a grant/)
    expect(declare({ read: ['owner'] })).toThrow(/access.read is not a policy or a grant/)
    expect(declare(['owner'])).toThrow(/not a policy, a grant or a per-verb object/)
    expect(declare({ read: 'public', update: undefined })).not.toThrow()
  })

  it('refuses an owner grant with no ownerColumn', () => {
    expect(declare({ update: { owner: true, roles: ['editor'] } }, { ownerColumn: undefined })).toThrow(/no ownerColumn/)
  })
})

describe('reads — canRead and visibleTo under a role grant and an owner-or-role grant', () => {
  const row = { id: 'n1', reviewed_by: 'alice', text: 'x' }

  it('lets only a role holder read a role-only collection', () => {
    expect(Object.entries(viewers).map(([who, v]) => [who, canRead(access('drafts'), { id: 'd', text: 'x' }, v)])).toEqual([
      ['anonymous', false],
      ['a uid without the role', false],
      ['a uid with the role', true],
      ['the row owner', false],
    ])
  })

  it('lets the owner or a role holder read an owner-or-role collection', () => {
    expect(Object.entries(viewers).map(([who, v]) => [who, canRead(access('notes'), row, v)])).toEqual([
      ['anonymous', false],
      ['a uid without the role', false],
      ['a uid with the role', true],
      ['the row owner', true],
    ])
  })

  it('does not count roles on a viewer with no uid', () => {
    expect(canRead(access('drafts'), { id: 'd', text: 'x' }, { uid: null, roles: ['editor'] })).toBe(false)
  })

  it('passes the whole batch to a role holder, and filters by owner for everyone else', () => {
    const b = batch('notes', [ins(row), ins({ id: 'n2', reviewed_by: 'bob', text: 'y' })])
    expect(visibleTo(access('notes'), b, carol)).toBe(b)
    expect(visibleTo(access('notes'), b, alice)?.ops.map((op) => op.value.id)).toEqual(['n1'])
    expect(visibleTo(access('notes'), b, ANONYMOUS)).toBeNull()
    expect(visibleTo(access('drafts'), { ...b, channel: 'drafts', reset: true }, bob)).toMatchObject({ ops: [], reset: true })
  })

  it('tells an owner who loses a row to reassignment that it is gone, but not an editor who still reads it', () => {
    const handOff: WriteEvent = { type: 'update', value: { id: 'n1', reviewed_by: 'bob', text: 'x' }, previousValue: row }
    const b = batch('notes', [handOff])
    expect(visibleTo(access('notes'), b, alice)?.ops).toEqual([{ type: 'delete', value: row }])
    expect(visibleTo(access('notes'), b, bob)?.ops).toEqual([{ type: 'insert', value: handOff.value }])
    expect(visibleTo(access('notes'), b, carol)).toBe(b)
  })
})

describe('fan-out — audiencesOf', () => {
  it('sends a one-role read to that role, as one frame', () => {
    const b = batch('drafts', [ins({ id: 'd', text: 'x' })])
    expect(audiencesOf(access('drafts'), b)).toEqual([{ audience: { role: 'editor' }, batch: b }])
  })

  it('marks an owner-or-role read and a two-role read as per-socket, since one user can be in two audiences', () => {
    const twoRoles = accessOf(definePartyCollection({ name: 't', key: 'id', schema: draftSchema, access: { read: { roles: ['editor', 'admin'] } } }))
    expect(access('notes').perSocket).toBe(true)
    expect(twoRoles.perSocket).toBe(true)
    expect(access('drafts').perSocket).toBe(false)
    expect(access('reviews').perSocket).toBe(false)
    expect(() => audiencesOf(access('notes'), batch('notes', []))).toThrow(/per socket/)
  })
})

describe('writes — every verb under a role grant and an owner-or-role grant', () => {
  const draft = { id: 'd1', text: 'x' }
  const ownReview = { id: 'r1', reviewed_by: 'alice', text: 'x' }

  it('lets only a role holder insert, update and delete a role-only collection', () => {
    for (const type of ['insert', 'update', 'delete'] as const) {
      const statuses = Object.values(viewers).map((v) => statusOf(() => gateWrite(byChannel, write('drafts', { type, value: draft }), v)))
      expect([type, ...statuses]).toEqual([type, 401, 403, 'ok', 403])
    }
  })

  it("refuses an anonymous update or delete of a review at the gate, and an update naming someone else's id", () => {
    const at = (type: 'update' | 'delete') =>
      Object.values(viewers).map((v) => statusOf(() => gateWrite(byChannel, write('reviews', { type, value: ownReview }), v)))
    expect(at('update')).toEqual([401, 403, 'ok', 'ok'])
    // a delete carries no owner the gate trusts; the stored row decides it below.
    expect(at('delete')).toEqual([401, 'ok', 'ok', 'ok'])
  })

  it("checks the owner against the stored row, not the payload, unless the writer holds the role", () => {
    const stored = new Map([['reviews', new Map([['r1', ownReview]])]])
    const claimed: WriteBatch[] = write('reviews', { type: 'update', value: { id: 'r1', reviewed_by: 'bob', text: 'mine now' } })
    // bob claims the row in the payload; the gate lets the claim through only as
    // his own id, and the stored row says it is alice's.
    expect(statusOf(() => applyPriorRows(byChannel, gateWrite(byChannel, claimed, bob), stored, bob))).toBe(403)
    const edit: WriteBatch[] = write('reviews', { type: 'update', value: { id: 'r1', text: 'edited' } })
    expect(statusOf(() => applyPriorRows(byChannel, edit, stored, bob))).toBe(403)
    expect(statusOf(() => applyPriorRows(byChannel, edit, stored, alice))).toBe('ok')
    expect(statusOf(() => applyPriorRows(byChannel, edit, stored, carol))).toBe('ok')
    const remove: WriteBatch[] = write('reviews', { type: 'delete', value: { id: 'r1' } })
    expect(statusOf(() => applyPriorRows(byChannel, remove, stored, bob))).toBe(403)
    expect(statusOf(() => applyPriorRows(byChannel, remove, stored, alice))).toBe('ok')
    expect(statusOf(() => applyPriorRows(byChannel, remove, stored, carol))).toBe('ok')
  })

  it('reads the prior row for an owner-or-role update, whoever writes it', () => {
    expect(needsPriorRow(access('reviews'), { type: 'update', value: ownReview })).toBe(true)
    expect(needsPriorRow(access('drafts'), { type: 'update', value: draft })).toBe(false)
  })

  it('lets an editor write a review for another owner, and stamps one where it names none', () => {
    const editorInsert = accessOf(
      definePartyCollection({ name: 'reviews', key: 'id', schema: reviewSchema, ownerColumn: 'reviewed_by', access: { insert: { owner: true, roles: ['editor'] } } }),
    )
    const m = new Map([['reviews', editorInsert]])
    const [forBob] = gateWrite(m, write('reviews', ins({ id: 'r2', reviewed_by: 'bob', text: 'x' })), carol)
    expect(forBob.ops[0].value.reviewed_by).toBe('bob')
    const [stamped] = gateWrite(m, write('reviews', ins({ id: 'r3', text: 'x' })), carol)
    expect(stamped.ops[0].value.reviewed_by).toBe('carol')
    expect(statusOf(() => gateWrite(m, write('reviews', ins({ id: 'r4', reviewed_by: 'alice', text: 'x' })), bob))).toBe(403)
  })

  it("names the missing role in the refusal", () => {
    try {
      gateWrite(byChannel, write('drafts', ins(draft)), bob)
    } catch (e) {
      expect((e as AccessDenied).message).toBe('insert on "drafts" requires the role "editor"')
    }
    expect.assertions(1)
  })
})

describe('identity — roles from claims, and role tags', () => {
  it('reads roles from claims.roles, and only beside a uid', () => {
    expect(viewerOf({ claims: { sub: 'carol', roles: ['editor', 7, '', 'admin'] } })).toEqual({ uid: 'carol', roles: ['editor', 'admin'] })
    expect(viewerOf({ claims: { sub: 'bob', roles: 'editor' } })).toEqual({ uid: 'bob', roles: [] })
    expect(viewerOf({ claims: { roles: ['editor'] } })).toEqual(ANONYMOUS)
    expect(viewerOf({ role: 'editor' })).toEqual(ANONYMOUS)
  })

  it('pins roles beside the uid and reads them back', () => {
    const tags = viewerTags(carol)
    expect(tags).toContain(audienceTag({ role: 'editor' }))
    expect(viewerFromTags(['conn-1', ...tags])).toEqual(carol)
  })

  it(`pins at most ${MAX_ROLE_TAGS} roles, so the socket stays under partyserver's 9 tags, and says so`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tags = viewerTags({ uid: 'x', roles: Array.from({ length: 9 }, (_, i) => `r${i}`) })
    expect(tags).toHaveLength(9)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('refuses a connection id shaped like one of its tags, which a client could pick to read as a uid or a role', () => {
    expect(() => assertConnectionId(audienceTag({ role: 'editor' }))).toThrow(/cannot start with/)
    expect(() => assertConnectionId(audienceTag({ uid: 'alice' }))).toThrow(/cannot start with/)
    expect(() => assertConnectionId('V1StGXR8_Z5jdHi6B-myT')).not.toThrow()
    const stackOf = (fn: () => void) => {
      try {
        fn()
      } catch (e) {
        return (e as Error).stack
      }
    }
    expect(stackOf(() => assertConnectionId('party-db:authed'))).toBe('a connection id cannot start with "party-db:"')
  })

  it('names the audiences that can read a per-socket batch: each role, and each owner before and after', () => {
    const row = { id: 'n1', reviewed_by: 'alice', text: 'x' }
    const handOff: WriteEvent = { type: 'update', value: { ...row, reviewed_by: 'bob' }, previousValue: row }
    expect(readersOf(access('notes'), batch('notes', [handOff, ins(row)]))).toEqual([{ role: 'editor' }, { uid: 'bob' }, { uid: 'alice' }])
  })

  it('lists the roles a room names, which are the only ones worth pinning', () => {
    expect([...rolesNamed([reviews, drafts, notes])]).toEqual(['editor'])
  })
})
