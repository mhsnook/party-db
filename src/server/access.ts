// The JS-layer access policies (issue #33, cookbook 5): who may read, insert,
// update, and delete each collection, enforced by party-db itself rather than by
// the database. This is the SQLite/D1 story, and it runs the same on Postgres;
// Postgres-native RLS (cookbook 8) is the opt-in alternative that lets the
// database judge instead.
//
// Everything here is pure: the core (core.ts) calls it at the choke points — the
// write gate, the snapshot, the `?since` backlog, and the fan-out — and owns the
// I/O around it. Honest about scope: this is a roughshod subset of RLS, not a
// security kernel. It gates what party-db's own CRUD and streams hand out; a host
// that writes rows with `commit()` is trusted and bypasses the write gate.

import type { SequencedBatch, WriteBatch, WriteEvent } from '../protocol.ts'
import type { AccessPolicy, PartyCollection } from '../schema.ts'
import type { WriteIdentity, WriteRejection } from './persistence.ts'
import { canHoldUid, columnsOf, idOf } from './columns.ts'

export type Verb = 'read' | WriteEvent['type']

// One policy per verb, after the shorthands are resolved.
export type Policies = Record<Verb, AccessPolicy>

// Who a read or write is judged for. `uid` is the verified identity's `sub`
// claim; null is anonymous.
export type Viewer = { uid: string | null }

export const ANONYMOUS: Viewer = { uid: null }

// Who one fan-out frame goes to. `all` is every party-db socket (the public fast
// path); `authed` is every socket with a uid; `{ uid }` is that user's sockets.
export type Audience = 'all' | 'authed' | { uid: string }

// A collection's access, resolved once at construction: its four policies, the
// column an `'owner'` policy compares against the viewer's uid, and the two
// derived flags the hot paths ask for. They are fields, not re-scans, because
// connect and every write read them.
export type CollectionAccess = {
  policies: Policies
  ownerColumn?: string
  key: string
  // every verb is 'public': behaves exactly as a collection with no declaration
  open: boolean
  // reads depend on the ROW's owner, so the fan-out has to know who owned it
  // before the write as well as after
  ownerRead: boolean
  // some update or delete on this collection needs its prior row read — the
  // collection-level form of `needsPriorRow`, so the boot check that demands
  // `readRows` and the per-op read cannot answer differently
  needsPrior: boolean
}

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
  const policies = policiesOf(collection)
  return {
    policies,
    ownerColumn: collection.ownerColumn,
    key: collection.key,
    open: Object.values(policies).every((policy) => policy === 'public'),
    ownerRead: policies.read === 'owner',
    needsPrior: policies.read === 'owner' || policies.update === 'owner' || policies.delete === 'owner',
  }
}

export { idOf } from './columns.ts'

// The uid the rules compare against: the verified identity's `sub` claim, read by
// the same rule as a row's owner column. Both sides of every comparison normalize
// the same way, so a verifier that hands back a numeric `sub` is not an id on one
// side and nobody on the other.
export function uidOf(identity: WriteIdentity | null | undefined): string | null {
  return idOf(identity?.claims?.sub)
}

// Fail at boot, not on the first request, when a declaration cannot be enforced
// as written.
export function checkAccess(collection: PartyCollection<any>): void {
  const { policies, ownerColumn } = accessOf(collection)
  const name = collection.name
  if (Object.values(policies).includes('owner') && ownerColumn === undefined) {
    throw new Error(`collection "${name}" uses an 'owner' policy but declares no ownerColumn to match it against`)
  }
  if (ownerColumn === undefined) return
  const columns = columnsOf(collection.schema)
  if (!columns) return // schema-less (blob): no declared columns to check against
  const column = columns.find((c) => c.name === ownerColumn)
  if (!column) throw new Error(`collection "${name}" names ownerColumn "${ownerColumn}", which its schema does not declare`)
  if (!canHoldUid(column)) {
    throw new Error(
      `collection "${name}" names ownerColumn "${ownerColumn}", which its schema types as ${column.tag}. ` +
        'An owner column holds a user id, so declare it as a string or a number.',
    )
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

// The row as it stood BEFORE this op, when the server read it: an update carries
// it as `previousValue`, stamped from the stored row inside the write queue — not
// the copy the client sent; a delete carries it as its value, for the same reason.
// Undefined when nothing was read, which is every insert and every collection
// whose reads don't depend on the row's owner.
function priorOf(op: WriteEvent): unknown {
  return op.type === 'delete' ? op.value : op.previousValue
}

// What `viewer` should see of one committed op, or null for nothing. Every read
// filter goes through here — the snapshot, the `?since` delta, the fan-out, and
// the write's own acknowledgement — so they cannot drift apart.
//
// A row can leave a viewer's reach without being deleted: reassign the owner
// column and the row is simply gone for the person who had it. The post-image
// alone cannot say that. Sending only the new owner's frame leaves the old owner
// holding a row the database no longer gives them — on this socket, and on every
// reconnect after it, because the `_oplog` entry carries that same post-image. So
// a viewer who could read the prior row and cannot read this one gets a delete of
// the prior row instead.
export function opFor(access: CollectionAccess, op: WriteEvent, viewer: Viewer): WriteEvent | null {
  const prior = priorOf(op)
  const sawPrior = prior !== undefined && canRead(access, prior, viewer)
  if (op.type === 'delete') return sawPrior ? op : null
  if (!canRead(access, op.value, viewer)) return sawPrior ? { type: 'delete', value: prior as Record<string, unknown> } : null
  // The row is theirs now but wasn't before, so their collection has never seen
  // this key and an update would have nothing to update. It carries no
  // previousValue: the row's former owner is not this viewer's business.
  if (op.type === 'update' && prior !== undefined && !sawPrior) return { type: 'insert', value: op.value }
  return op
}

// `batch` as `viewer` may see it. A snapshot (`reset`) is always returned, empty
// if need be, so the client's collection still truncates and turns ready. A delta
// or fan-out batch with nothing visible returns null — the caller sends nothing.
export function visibleTo(access: CollectionAccess, batch: SequencedBatch, viewer: Viewer): SequencedBatch | null {
  const read = access.policies.read
  // 'public' and 'authed' answer for the whole batch without looking at a row, so
  // they never pay for a per-op pass.
  if (read === 'public') return batch
  if (read === 'authed' && viewer.uid !== null) return batch
  if (read !== 'owner') return batch.reset ? { ...batch, ops: [] } : null
  const ops: WriteEvent[] = []
  let changed = false
  for (const op of batch.ops) {
    const seen = opFor(access, op, viewer)
    if (seen) ops.push(seen)
    if (seen !== op) changed = true
  }
  if (!ops.length && !batch.reset) return null
  return changed ? { ...batch, ops } : batch
}

// Split one committed batch into the frames its fan-out sends, and to whom. A
// public collection is one frame to everyone (§9's single serialization, kept);
// an 'owner' collection is one frame per owner holding only that owner's rows —
// the owner a row has now, and the one it had before, so a row changing hands is
// a delete for the person losing it.
export function audiencesOf(access: CollectionAccess, batch: SequencedBatch): { audience: Audience; batch: SequencedBatch }[] {
  const read = access.policies.read
  if (read === 'public') return [{ audience: 'all', batch }]
  if (read === 'authed') return [{ audience: 'authed', batch }]
  if (read === 'none') return []
  const byOwner = new Map<string, WriteEvent[]>()
  const add = (uid: string | null, op: WriteEvent | null) => {
    if (uid === null || op === null) return
    const ops = byOwner.get(uid)
    if (ops) ops.push(op)
    else byOwner.set(uid, [op])
  }
  // Each op's two owners are derived once here rather than re-read per audience:
  // this runs inside the serialized commit section, where the room waits on it.
  for (const op of batch.ops) {
    const prior = priorOf(op)
    const before = ownerOf(access, prior)
    const now = op.type === 'delete' ? null : ownerOf(access, op.value)
    if (now !== null) add(now, now === before || prior === undefined ? op : { type: 'insert', value: op.value })
    if (before !== null && before !== now) add(before, { type: 'delete', value: prior as Record<string, unknown> })
  }
  return [...byOwner].map(([uid, ops]) => ({ audience: { uid }, batch: { ...batch, ops } }))
}

// ---- writes ----

// A write the policies refuse. It carries a `WriteRejection` for the same reason
// `MissedUpdateError` does: `handleWrite` has one renderer for a refusal, and a
// second one would be a second place to keep the shape right.
export class AccessDenied extends Error {
  readonly rejection: WriteRejection

  constructor(status: 401 | 403, message: string, readonly channel: string) {
    super(message)
    this.name = 'AccessDenied'
    this.rejection = { error: message, channel, status }
  }
}

// The checks that need nothing but the payload: each op's verb against its
// policy, and the owner column on an 'owner' insert or update. Returns the batches
// to commit, with the owner column stamped from the writer's uid on an 'owner'
// insert that omitted it. Throws AccessDenied.
//
// An 'owner' update or delete also has to match the STORED row; that check needs a
// read and runs later, inside the write queue (`applyPriorRows`).
export function gateWrite(accessByChannel: Map<string, CollectionAccess>, batches: WriteBatch[], viewer: Viewer): WriteBatch[] {
  return batches.map((batch) => {
    const access = accessByChannel.get(batch.channel)
    if (!access || access.open) return batch
    return { ...batch, ops: batch.ops.map((op) => gateOp(access, batch.channel, op, viewer)) }
  })
}

// Every op reaching here has passed `isWritableOp` (protocol.ts): its type is one
// of the three, and its value is a plain object. Re-checking that would be a third
// spelling of one rule.
function gateOp(access: CollectionAccess, channel: string, op: WriteEvent, viewer: Viewer): WriteEvent {
  const policy = access.policies[op.type]
  if (policy === 'public') return op
  if (policy === 'none') throw new AccessDenied(403, `${op.type} is not allowed on "${channel}"`, channel)
  if (viewer.uid === null) throw new AccessDenied(401, `${op.type} on "${channel}" requires a signed-in user`, channel)
  if (policy === 'authed') return op

  // 'owner': the owner column must be the writer's own uid, never someone else's.
  const column = access.ownerColumn!
  const value = op.value as Record<string, unknown>
  // presence is read raw (an absent column is stamped); the comparison is by id,
  // so a client sending the number 1 for a SERIAL column matches the claim "1".
  const owner = value[column]
  if (op.type === 'insert' && (owner === undefined || owner === null)) {
    return { ...op, value: { ...value, [column]: viewer.uid } }
  }
  if (op.type !== 'delete' && owner !== undefined && idOf(owner) !== viewer.uid) {
    throw new AccessDenied(403, `"${column}" must be your own id on "${channel}"`, channel)
  }
  return op
}

// Which ops need the stored row read before the write. Two different reasons, and
// they do NOT select the same ops — gating on the write policy alone is what let a
// row change hands without telling the person who lost it:
//   - to authorize: an 'owner' update or delete must match the STORED owner, not
//     the one the payload claims.
//   - to route: an 'owner' READ has to know who owned the row before the write, or
//     the fan-out and the `_oplog` entry can only name the new owner.
// The second reason applies to a trusted host write too, which is authorized
// already but still has to reach the right sockets.
export function needsPriorRow(access: CollectionAccess, op: WriteEvent): boolean {
  if (op.type === 'insert') return false
  return access.policies[op.type] === 'owner' || access.ownerRead
}

// The keys whose stored rows the write needs, grouped by channel and deduped.
export function storedKeysNeeded(accessByChannel: Map<string, CollectionAccess>, batches: WriteBatch[]): Map<string, unknown[]> {
  const needed = new Map<string, unknown[]>()
  const seen = new Map<string, Set<unknown>>()
  for (const batch of batches) {
    const access = accessByChannel.get(batch.channel)
    if (!access) continue
    for (const op of batch.ops) {
      if (!needsPriorRow(access, op)) continue
      const key = (op.value as Record<string, unknown> | null)?.[access.key]
      let keys = seen.get(batch.channel)
      if (!keys) seen.set(batch.channel, (keys = new Set()))
      if (keys.has(key)) continue
      keys.add(key)
      const list = needed.get(batch.channel)
      if (list) list.push(key)
      else needed.set(batch.channel, [key])
    }
  }
  return needed
}

// The stored-row half of the write, run inside the queue so no other write of this
// room can change a row between the read and the commit. It does two jobs:
//
//   - With a `viewer`, it enforces the 'owner' update and delete: a row owned by
//     someone else is a 403. A key with no stored row passes — an update of it is
//     the §16 missing-row rejection the adapter already raises, and a delete of it
//     deletes nothing.
//   - Always, it stamps the prior row onto the op: a delete carries it as its
//     value, and an update on an owner-read collection as `previousValue`. Both
//     ride into the `_oplog`, so the fan-out AND every later `?since` replay route
//     by who really owned the row, never by an owner the client claimed.
export function applyPriorRows(
  accessByChannel: Map<string, CollectionAccess>,
  batches: WriteBatch[],
  stored: Map<string, Map<string, Record<string, unknown>>>,
  viewer?: Viewer,
): WriteBatch[] {
  return batches.map((batch) => {
    const access = accessByChannel.get(batch.channel)
    const rows = stored.get(batch.channel)
    if (!access || !rows) return batch
    const ops = batch.ops.map((op) => {
      if (!needsPriorRow(access, op)) return op
      const value = op.value as Record<string, unknown> | null
      const row = rows.get(String(value?.[access.key]))
      if (viewer && access.policies[op.type] === 'owner' && row && idOf(row[access.ownerColumn!]) !== viewer.uid) {
        throw new AccessDenied(403, `that row on "${batch.channel}" is not yours to ${op.type}`, batch.channel)
      }
      if (op.type === 'delete') return { ...op, value: row ?? stampOwner(access, value, viewer) }
      return access.ownerRead && row ? { ...op, previousValue: row } : op
    })
    return { ...batch, ops }
  })
}

// A delete of a row that isn't there still has to reach the person who asked for
// it, so it carries their own uid in the owner column rather than an owner the
// payload named.
function stampOwner(access: CollectionAccess, value: Record<string, unknown> | null, viewer?: Viewer): Record<string, unknown> {
  const row = { ...value }
  if (viewer && access.ownerColumn) row[access.ownerColumn] = viewer.uid
  return row
}

function ownerOf(access: CollectionAccess, row: unknown): string | null {
  if (access.ownerColumn === undefined) return null
  return idOf((row as Record<string, unknown> | null)?.[access.ownerColumn])
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
