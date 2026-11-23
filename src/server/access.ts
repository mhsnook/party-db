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
import type { AccessGrant, PartyCollection, VerbAccess } from '../schema.ts'
import type { WriteIdentity, WriteRejection } from './persistence.ts'
import { canHoldUid, columnsOf, idOf } from './columns.ts'

export type Verb = 'read' | WriteEvent['type']

const VERBS: readonly Verb[] = ['read', 'insert', 'update', 'delete']

// 'owner' and every `AccessGrant`, resolved to one shape: met by the row's owner
// when `owner` is set, or by a signed-in viewer holding any of `roles`.
export type Grant = { owner: boolean; roles: readonly string[] }

// One rule per verb, after the shorthands are resolved. 'owner' is a `Grant`
// here, so every ownership check reads one shape.
export type Rule = 'public' | 'authed' | 'none' | Grant
export type Policies = Record<Verb, Rule>

// Who a read or write is judged for. `uid` is the verified identity's `sub`
// claim; null is anonymous. `roles` is its `claims.roles`, and is always empty
// without a uid.
export type Viewer = { uid: string | null; roles?: readonly string[] }

export const ANONYMOUS: Viewer = { uid: null, roles: [] }

// Who one fan-out frame goes to. `all` is every party-db socket (the public fast
// path); `authed` is every socket with a uid; `{ uid }` is that user's sockets;
// `{ role }` is the sockets of every user holding that role.
export type Audience = 'all' | 'authed' | { uid: string } | { role: string }

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
  // the read rule cannot be split into audiences that never overlap: an owner
  // who also holds a role, or one user holding two of the roles, would be sent
  // the same op twice. The fan-out filters per socket instead (`audiencesOf`).
  perSocket: boolean
}

const every = (rule: Rule): Policies => ({ read: rule, insert: rule, update: rule, delete: rule })

function ruleOf(policy: VerbAccess | undefined): Rule {
  if (policy === undefined) return 'none'
  if (policy === 'owner') return { owner: true, roles: [] }
  if (typeof policy === 'string') return policy
  return { owner: policy.owner === true, roles: [...(policy.roles ?? [])] }
}

function isGrant(access: object): access is AccessGrant {
  return 'owner' in access || 'roles' in access
}

// Whether `rule` can be met by owning the row.
export function ownedBy(rule: Rule): rule is Grant {
  return typeof rule === 'object' && rule.owner
}

function holdsAny(viewer: Viewer, roles: readonly string[]): boolean {
  return viewer.uid !== null && roles.some((role) => viewer.roles?.includes(role) === true)
}

// The shorthands, exactly as cookbook 5 states them:
//   - no `access`, no `ownerColumn` → 'public' on all four verbs
//   - no `access`, an `ownerColumn` → 'owner' on all four (fully private)
//   - a single policy or grant → that rule on all four
//   - the object form → the named verbs; every verb you don't name is 'none'
export function policiesOf(collection: PartyCollection<any>): Policies {
  const access = collection.access
  if (access === undefined) return every(ruleOf(collection.ownerColumn === undefined ? 'public' : 'owner'))
  if (typeof access === 'string' || isGrant(access)) return every(ruleOf(access))
  return {
    read: ruleOf(access.read),
    insert: ruleOf(access.insert),
    update: ruleOf(access.update),
    delete: ruleOf(access.delete),
  }
}

export function accessOf(collection: PartyCollection<any>): CollectionAccess {
  const policies = policiesOf(collection)
  const read = policies.read
  const ownerRead = ownedBy(read)
  return {
    policies,
    ownerColumn: collection.ownerColumn,
    key: collection.key,
    open: Object.values(policies).every((rule) => rule === 'public'),
    ownerRead,
    needsPrior: ownerRead || ownedBy(policies.update) || ownedBy(policies.delete),
    perSocket: typeof read === 'object' && read.roles.length > 0 && (read.owner || read.roles.length > 1),
  }
}

// Every role any rule of `collections` names: the only roles worth pinning to a
// socket, since a role no rule names can never change what the socket is sent.
export function rolesNamed(collections: PartyCollection<any>[]): Set<string> {
  const roles = new Set<string>()
  for (const collection of collections) {
    for (const rule of Object.values(policiesOf(collection))) {
      if (typeof rule === 'object') rule.roles.forEach((role) => roles.add(role))
    }
  }
  return roles
}

export { idOf } from './columns.ts'

// The uid the rules compare against: the verified identity's `sub` claim, read by
// the same rule as a row's owner column. Both sides of every comparison normalize
// the same way, so a verifier that hands back a numeric `sub` is not an id on one
// side and nobody on the other.
export function uidOf(identity: WriteIdentity | null | undefined): string | null {
  return idOf(identity?.claims?.sub)
}

// The viewer a verified identity names: its uid, and its `claims.roles`. Roles
// count only beside a uid, so an identity with roles and no `sub` is anonymous.
// Entries that are not non-empty strings are dropped.
export function viewerOf(identity: WriteIdentity | null | undefined): Viewer {
  const uid = uidOf(identity)
  if (uid === null) return ANONYMOUS
  const roles = identity?.claims?.roles
  return { uid, roles: Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string' && r !== '') : [] }
}

// Fail at boot, not on the first request, when a declaration cannot be enforced
// as written.
export function checkAccess(collection: PartyCollection<any>): void {
  const name = collection.name
  checkDeclared(name, collection.access)
  const { policies, ownerColumn } = accessOf(collection)
  if (Object.values(policies).some(ownedBy) && ownerColumn === undefined) {
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

// The declaration's own shape, before it is resolved. A key the resolver does not
// read would otherwise deny silently: `{ role: 'editor' }` is not a grant, and
// `{ roles: [...], read: 'public' }` is neither a grant nor the per-verb form.
function checkDeclared(name: string, access: PartyCollection<any>['access']): void {
  if (access === undefined || typeof access === 'string') return
  if (typeof access !== 'object' || access === null) throw new Error(`collection "${name}" has an access declaration that is not a policy or an object`)
  if (isGrant(access)) return checkGrant(name, 'access', access)
  for (const key of Object.keys(access)) {
    if (!VERBS.includes(key as Verb)) {
      throw new Error(
        `collection "${name}" names "${key}" in access. Use read, insert, update and delete, or a single grant { owner, roles }.`,
      )
    }
    const rule = (access as Record<string, unknown>)[key]
    if (typeof rule === 'object' && rule !== null) checkGrant(name, `access.${key}`, rule as AccessGrant)
  }
}

function checkGrant(name: string, where: string, grant: AccessGrant): void {
  const at = `collection "${name}" ${where}`
  for (const key of Object.keys(grant)) {
    if (key !== 'owner' && key !== 'roles') throw new Error(`${at} names "${key}" in a grant. A grant takes owner: true and roles: string[].`)
  }
  if (grant.owner !== undefined && grant.owner !== true) throw new Error(`${at} sets owner to ${String(grant.owner)}. Set it to true, or leave it out.`)
  const roles: unknown = grant.roles
  if (roles !== undefined && (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string' || r === ''))) {
    throw new Error(`${at} has roles that are not a list of non-empty strings`)
  }
  if (grant.owner !== true && !grant.roles?.length) throw new Error(`${at} is a grant that nobody can meet: set owner: true or name a role`)
  for (const role of grant.roles ?? []) {
    if (ROLE_TAG.length + role.length > MAX_TAG) throw new Error(`${at} names a role of ${role.length} characters, too long to pin to a socket`)
  }
}

// ---- reads ----

// Whether `viewer` may see `row` under a read policy.
export function canRead(access: CollectionAccess, row: unknown, viewer: Viewer): boolean {
  const rule = access.policies.read
  if (rule === 'public') return true
  if (rule === 'none' || viewer.uid === null) return false
  if (rule === 'authed') return true
  return holdsAny(viewer, rule.roles) || (rule.owner && ownerOf(access, row) === viewer.uid)
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
  // 'public', 'authed' and a held role answer for the whole batch without looking
  // at a row, so they never pay for a per-op pass.
  if (read === 'public') return batch
  if (read === 'authed' && viewer.uid !== null) return batch
  if (typeof read === 'object' && holdsAny(viewer, read.roles)) return batch
  if (!ownedBy(read)) return batch.reset ? { ...batch, ops: [] } : null
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
// a one-role read is one frame to that role; an 'owner' collection is one frame
// per owner holding only that owner's rows — the owner a row has now, and the one
// it had before, so a row changing hands is a delete for the person losing it.
//
// A `perSocket` collection has no such split, and the core filters it per socket
// with `visibleTo` instead; asking here is a bug in the caller.
export function audiencesOf(access: CollectionAccess, batch: SequencedBatch): { audience: Audience; batch: SequencedBatch }[] {
  const read = access.policies.read
  if (read === 'public') return [{ audience: 'all', batch }]
  if (read === 'authed') return [{ audience: 'authed', batch }]
  if (read === 'none') return []
  if (access.perSocket) throw new Error(`channel "${batch.channel}" fans out per socket, not by audience`)
  if (!read.owner) return [{ audience: { role: read.roles[0] }, batch }]
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
  const rule = access.policies[op.type]
  if (rule === 'public') return op
  if (rule === 'none') throw new AccessDenied(403, `${op.type} is not allowed on "${channel}"`, channel)
  if (viewer.uid === null) throw new AccessDenied(401, `${op.type} on "${channel}" requires a signed-in user`, channel)
  if (rule === 'authed') return op

  const column = access.ownerColumn
  const value = op.value as Record<string, unknown>
  // presence is read raw (an absent column is stamped); the comparison is by id,
  // so a client sending the number 1 for a SERIAL column matches the claim "1".
  const owner = column === undefined ? undefined : value[column]
  const stamp = rule.owner && op.type === 'insert' && (owner === undefined || owner === null)
  // A role holder may write a row for any owner. An owner grant still stamps an
  // insert that names none, so the row has an owner to be read back by.
  if (holdsAny(viewer, rule.roles)) return stamp ? { ...op, value: { ...value, [column!]: viewer.uid } } : op
  if (!rule.owner) {
    throw new AccessDenied(403, `${op.type} on "${channel}" requires the role ${rule.roles.map((r) => `"${r}"`).join(' or ')}`, channel)
  }

  // the owner column must be the writer's own uid, never someone else's.
  if (stamp) return { ...op, value: { ...value, [column!]: viewer.uid } }
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
  return ownedBy(access.policies[op.type]) || access.ownerRead
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
      const rule = access.policies[op.type]
      const byOwner = ownedBy(rule) && !(viewer && holdsAny(viewer, rule.roles))
      if (viewer && byOwner && row && idOf(row[access.ownerColumn!]) !== viewer.uid) {
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
const ROLE_TAG = 'party-db:role:'
// partyserver caps a tag at 256 characters, and a socket at 9 tags of its own.
const MAX_TAG = 256
// what is left of the 9 after the authed and uid tags
export const MAX_ROLE_TAGS = 7

// The tags that pin `viewer` to its socket. A uid too long to fit in a tag is not
// pinned: that socket reads as anonymous, and a warning says why. Past
// `MAX_ROLE_TAGS` roles, the rest are not pinned, and a warning says so: that
// socket is sent less than the user may read, never more.
export function viewerTags(viewer: Viewer): string[] {
  if (viewer.uid === null) return []
  if (UID_TAG.length + viewer.uid.length > MAX_TAG) {
    console.warn(`party-db: a uid of ${viewer.uid.length} characters is too long to pin to a socket; it reads as anonymous`)
    return []
  }
  const roles = [...new Set(viewer.roles ?? [])].filter((role) => ROLE_TAG.length + role.length <= MAX_TAG)
  if (roles.length > MAX_ROLE_TAGS) {
    console.warn(`party-db: a socket can pin ${MAX_ROLE_TAGS} roles; ${roles.length - MAX_ROLE_TAGS} of this user's roles are not pinned`)
  }
  return [AUTHED_TAG, UID_TAG + viewer.uid, ...roles.slice(0, MAX_ROLE_TAGS).map((role) => ROLE_TAG + role)]
}

// The viewer a socket's tags pin, or anonymous.
export function viewerFromTags(tags: readonly string[]): Viewer {
  const tag = tags.find((t) => t.startsWith(UID_TAG))
  if (!tag) return ANONYMOUS
  return { uid: tag.slice(UID_TAG.length), roles: tags.filter((t) => t.startsWith(ROLE_TAG)).map((t) => t.slice(ROLE_TAG.length)) }
}

// The tag that selects an audience's sockets.
export function audienceTag(audience: Exclude<Audience, 'all'>): string {
  if (audience === 'authed') return AUTHED_TAG
  return 'uid' in audience ? UID_TAG + audience.uid : ROLE_TAG + audience.role
}
