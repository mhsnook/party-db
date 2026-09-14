// The JS-layer access policies (issue #33, cookbook 5): who may read, insert,
// update, and delete each collection, enforced by party-db itself rather than by
// the database. This is the SQLite/D1 story, and it runs the same on Postgres;
// Postgres-native RLS (cookbook 8) is the opt-in alternative that lets the
// database judge instead.
//
// Everything here is pure: the core (core.ts) calls it at the four choke points —
// the write gate, the snapshot, the `?since` backlog, and the fan-out — and owns
// the I/O around it. Honest about scope: this is a roughshod subset of RLS, not a
// security kernel. It gates what party-db's own CRUD and streams hand out; a host
// that writes rows with `commit()` is trusted and bypasses the write gate.

import type { SequencedBatch, WriteBatch, WriteEvent } from '../protocol.ts'
import type { AccessPolicy, PartyCollection } from '../schema.ts'
import type { WriteIdentity } from './persistence.ts'

export type Verb = 'read' | 'insert' | 'update' | 'delete'

// One policy per verb, after the shorthands are resolved.
export type Policies = Record<Verb, AccessPolicy>

// Who a read or write is judged for. `uid` is the verified identity's `sub`
// claim; null is anonymous.
export type Viewer = { uid: string | null }

export const ANONYMOUS: Viewer = { uid: null }

// Who one fan-out frame goes to. `all` is every party-db socket (the public fast
// path); `authed` is every socket with a uid; `{ uid }` is that user's sockets.
export type Audience = 'all' | 'authed' | { uid: string }

// A collection's access, resolved once at construction: its four policies and the
// column an `'owner'` policy compares against the viewer's uid.
export type CollectionAccess = { policies: Policies; ownerColumn?: string; key: string }

const every = (policy: AccessPolicy): Policies => ({ read: policy, insert: policy, update: policy, delete: policy })

// The shorthands, exactly as cookbook 5 states them:
//   - no `access`, no `ownerColumn` → 'public' on all four verbs
//   - no `access`, an `ownerColumn` → 'owner' on all four (fully private)
//   - a single policy → that policy on all four
//   - the object form → the named verbs; every verb you don't name is 'none'
export function policiesOf(collection: PartyCollection<any>): Policies {
  const access = collection.access
  if (access === undefined) return every(collection.ownerColumn === undefined ? 'public' : 'owner')
  if (typeof access === 'string') return every(access)
  return {
    read: access.read ?? 'none',
    insert: access.insert ?? 'none',
    update: access.update ?? 'none',
    delete: access.delete ?? 'none',
  }
}

export function accessOf(collection: PartyCollection<any>): CollectionAccess {
  return { policies: policiesOf(collection), ownerColumn: collection.ownerColumn, key: collection.key }
}

// True when every verb is 'public' — the collection behaves exactly as a
// collection with no access declaration always has.
export const isOpen = (access: CollectionAccess) =>
  Object.values(access.policies).every((policy) => policy === 'public')

// The uid the rules compare against: the verified identity's `sub` claim.
export function uidOf(identity: WriteIdentity | null | undefined): string | null {
  const sub = identity?.claims?.sub
  return typeof sub === 'string' && sub !== '' ? sub : null
}

// Fail at boot, not on the first request, when a declaration cannot be enforced
// as written. `columns` is the collection's column allowlist when it has a
// structured schema (null for a schema-less blob collection, which has no fixed
// columns to check against).
export function checkAccess(collection: PartyCollection<any>, columns: string[] | null): void {
  const { policies, ownerColumn } = accessOf(collection)
  const usesOwner = Object.values(policies).includes('owner')
  if (usesOwner && ownerColumn === undefined) {
    throw new Error(`collection "${collection.name}" uses an 'owner' policy but declares no ownerColumn to match it against`)
  }
  if (ownerColumn !== undefined && columns !== null && !columns.includes(ownerColumn)) {
    throw new Error(`collection "${collection.name}" names ownerColumn "${ownerColumn}", which its schema does not declare`)
  }
}

// ---- reads ----

// Whether `viewer` may see `row` under a read policy.
export function canRead(access: CollectionAccess, row: unknown, viewer: Viewer): boolean {
  switch (access.policies.read) {
    case 'public':
      return true
    case 'authed':
      return viewer.uid !== null
    case 'owner':
      return viewer.uid !== null && ownerOf(access, row) === viewer.uid
    case 'none':
      return false
  }
}

// `batch` as `viewer` may see it. A snapshot (`reset`) is always returned, empty
// if need be, so the client's collection still truncates and turns ready. A delta
// or fan-out batch with nothing visible returns null — the caller sends nothing.
export function visibleTo(access: CollectionAccess | undefined, batch: SequencedBatch, viewer: Viewer): SequencedBatch | null {
  if (!access || access.policies.read === 'public') return batch
  const ops = batch.ops.filter((op) => canRead(access, op.value, viewer))
  if (!ops.length && !batch.reset) return null
  return ops.length === batch.ops.length ? batch : { ...batch, ops }
}

// Split one committed batch into the frames its fan-out sends, and to whom. A
// public collection is one frame to everyone (§9's single serialization, kept);
// an 'owner' collection is one frame per owner holding only that owner's rows.
export function audiencesOf(access: CollectionAccess | undefined, batch: SequencedBatch): { audience: Audience; batch: SequencedBatch }[] {
  const read = access?.policies.read ?? 'public'
  if (read === 'public') return [{ audience: 'all', batch }]
  if (read === 'authed') return [{ audience: 'authed', batch }]
  if (read === 'none') return []
  const byOwner = new Map<string, WriteEvent[]>()
  for (const op of batch.ops) {
    const owner = ownerOf(access!, op.value)
    if (typeof owner !== 'string' || owner === '') continue // a row with no owner is nobody's to read
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), op])
  }
  return [...byOwner].map(([uid, ops]) => ({ audience: { uid }, batch: { ...batch, ops } }))
}

// ---- writes ----

// A write the policies refuse. `status` is 401 when the writer has no uid and the
// verb needs one, 403 when a uid is present but not allowed.
export class AccessDenied extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
    readonly channel: string,
  ) {
    super(message)
    this.name = 'AccessDenied'
  }
}

// The checks that need nothing but the payload: each op's verb against its
// policy, and the owner column on an 'owner' insert or update. Returns the batches
// to commit, with the owner column stamped from the writer's uid on an 'owner'
// insert that omitted it. Throws AccessDenied.
//
// An 'owner' update or delete also has to match the STORED row; that check needs a
// read and runs later, inside the write queue (`checkStored`).
export function gateWrite(accessByChannel: Map<string, CollectionAccess>, batches: WriteBatch[], viewer: Viewer): WriteBatch[] {
  return batches.map((batch) => {
    const access = accessByChannel.get(batch.channel)
    if (!access || isOpen(access)) return batch
    const ops = batch.ops.map((op) => gateOp(access, batch.channel, op, viewer))
    return { ...batch, ops }
  })
}

function gateOp(access: CollectionAccess, channel: string, op: WriteEvent, viewer: Viewer): WriteEvent {
  const policy = access.policies[op.type]
  if (policy === 'public') return op
  if (policy === 'none') throw new AccessDenied(403, `${op.type} is not allowed on "${channel}"`, channel)
  if (viewer.uid === null) throw new AccessDenied(401, `${op.type} on "${channel}" requires a signed-in user`, channel)
  if (policy === 'authed') return op

  // 'owner': the owner column must be the writer's own uid, never someone else's.
  const column = access.ownerColumn!
  const value = op.value as Record<string, unknown>
  const owner = value[column]
  if (op.type === 'insert' && (owner === undefined || owner === null)) {
    return { ...op, value: { ...value, [column]: viewer.uid } }
  }
  if (op.type !== 'delete' && owner !== undefined && owner !== viewer.uid) {
    throw new AccessDenied(403, `"${column}" must be your own id on "${channel}"`, channel)
  }
  return op
}

// Which ops need their stored row read before the write: every update and delete
// under an 'owner' policy. Keys grouped by channel.
export function storedKeysNeeded(accessByChannel: Map<string, CollectionAccess>, batches: WriteBatch[]): Map<string, unknown[]> {
  const needed = new Map<string, unknown[]>()
  for (const batch of batches) {
    const access = accessByChannel.get(batch.channel)
    if (!access) continue
    for (const op of batch.ops) {
      if (op.type === 'insert' || access.policies[op.type] !== 'owner') continue
      const key = (op.value as Record<string, unknown>)[access.key]
      needed.set(batch.channel, [...(needed.get(batch.channel) ?? []), key])
    }
  }
  return needed
}

// The stored-row half of the 'owner' check, for updates and deletes. `stored`
// holds each channel's current rows by key. A row owned by someone else is a 403.
// A key with no stored row passes: an update of it is the §16 missing-row
// rejection the adapter already raises, and a delete of it deletes nothing.
//
// Deletes are rewritten to carry the stored row (or, for a missing row, just the
// writer's own uid in the owner column), so the fan-out and the `_oplog` route a
// delete by who really owned the row — never by an owner the client claimed.
export function checkStored(
  accessByChannel: Map<string, CollectionAccess>,
  batches: WriteBatch[],
  stored: Map<string, Map<string, Record<string, unknown>>>,
  viewer: Viewer,
): WriteBatch[] {
  return batches.map((batch) => {
    const access = accessByChannel.get(batch.channel)
    const rows = stored.get(batch.channel)
    if (!access || !rows) return batch
    const column = access.ownerColumn!
    const ops = batch.ops.map((op) => {
      if (op.type === 'insert' || access.policies[op.type] !== 'owner') return op
      const value = op.value as Record<string, unknown>
      const row = rows.get(String(value[access.key]))
      if (row && row[column] !== viewer.uid) {
        throw new AccessDenied(403, `that row on "${batch.channel}" is not yours to ${op.type}`, batch.channel)
      }
      if (op.type !== 'delete') return op
      return { ...op, value: row ?? { ...value, [column]: viewer.uid } }
    })
    return { ...batch, ops }
  })
}

function ownerOf(access: CollectionAccess, row: unknown): unknown {
  return access.ownerColumn === undefined ? undefined : (row as Record<string, unknown> | null)?.[access.ownerColumn]
}

// ---- pinning a user to a socket ----
//
// A socket's user is resolved once, at connect, and pinned to the socket as
// partyserver connection tags, which survive hibernation and index
// `getConnections(tag)`: the fan-out finds a user's sockets with one lookup.
// `PartyDbServer` uses exactly this scheme; a composed host (§15) can reuse it.

const AUTHED_TAG = 'party-db:authed'
const UID_TAG = 'party-db:uid:'
// partyserver caps a tag at 256 characters.
const MAX_TAG = 256

// The tags that pin `viewer` to its socket. A uid too long to fit in a tag is not
// pinned: that socket reads as anonymous, and a warning says why.
export function viewerTags(viewer: Viewer): string[] {
  if (viewer.uid === null) return []
  if (UID_TAG.length + viewer.uid.length > MAX_TAG) {
    console.warn(`party-db: a uid of ${viewer.uid.length} characters is too long to pin to a socket; it reads as anonymous`)
    return []
  }
  return [AUTHED_TAG, UID_TAG + viewer.uid]
}

// The viewer a socket's tags pin, or anonymous.
export function viewerFromTags(tags: readonly string[]): Viewer {
  const tag = tags.find((t) => t.startsWith(UID_TAG))
  return tag ? { uid: tag.slice(UID_TAG.length) } : ANONYMOUS
}

// The tag that selects an audience's sockets.
export function audienceTag(audience: Exclude<Audience, 'all'>): string {
  return audience === 'authed' ? AUTHED_TAG : UID_TAG + audience.uid
}
