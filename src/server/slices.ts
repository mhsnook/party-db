// Who is subscribed to which slice, for a room whose host hands the core its
// connections (`PartyDbCoreOptions.connections`). A write to a sliced channel goes
// to the sockets watching that row's slice, plus the ones watching the whole
// channel — never a loop over every socket (docs/architecture.md §18).
//
// The index lives in memory and dies with the Durable Object's isolate. Each
// connection also keeps its own subscriptions in a slot that survives hibernation
// (`saveSubscriptions`); the first lookup after a wake rebuilds the index from
// those slots, once.

import { subscriptionKey, type SliceValue } from '../protocol.ts'
import type { Viewer } from './access.ts'

// One subscription: a channel, and the slice of it, or `null` for the whole channel.
export type Subscription = [channel: string, slice: SliceValue | null]

// A socket the core routes sliced channels to by itself. `PartyDbServer` builds
// these over partyserver connections; a composed host (§15) builds its own.
export interface PartyDbConnection {
  id: string
  send: (message: string) => void
  // who the socket belongs to, as pinned at connect (`resolveViewer`).
  viewer: Viewer
  // a slot that survives hibernation. `null` means nothing was saved, or the slot
  // was overwritten — the core then sends this socket every sliced channel whole,
  // because over-delivering is safe and missing a row is not.
  loadSubscriptions: () => Subscription[] | null
  saveSubscriptions: (subscriptions: Subscription[]) => void
}

// Past this many slices of one channel, a socket's slices of that channel fold
// into one whole-channel subscription.
export const MAX_SUBSCRIPTIONS = 100

// The hibernation slot is 16 KiB, shared with partyserver's own record and the
// app's `state`. A socket whose subscriptions outgrow this budget (long slice
// values, many channels) is folded to every channel whole, which always fits.
const MAX_SLOT_BYTES = 8_192
const bytesOf = (subscriptions: Subscription[]) => new TextEncoder().encode(JSON.stringify(subscriptions)).length

type Entry = { conn: PartyDbConnection; subscriptions: Subscription[] }

const keyOf = ([, slice]: Subscription) => subscriptionKey(slice)

export class SliceRoutes {
  private entries = new Map<string, Entry>()
  // channel → subscriptionKey → connection ids
  private watchers = new Map<string, Map<string, Set<string>>>()

  constructor(private slicedChannels: string[]) {}

  // index one connection with what it saved; a missing record means every sliced
  // channel, whole.
  restore(conn: PartyDbConnection): void {
    this.index(conn, conn.loadSubscriptions() ?? this.slicedChannels.map((channel): Subscription => [channel, null]))
  }

  // a fresh connection starts subscribed to nothing, and says so in its slot, so a
  // later rebuild can tell "nothing" from "lost".
  reset(conn: PartyDbConnection): void {
    this.index(conn, [])
    conn.saveSubscriptions([])
  }

  // A slice is recorded even while the socket holds the whole channel: the client
  // drops the whole-channel subscription on its own, and must keep its slices.
  subscribe(conn: PartyDbConnection, channel: string, slice: SliceValue | null): void {
    const current = this.entries.get(conn.id)?.subscriptions ?? []
    const key = subscriptionKey(slice)
    if (current.some((s) => s[0] === channel && keyOf(s) === key)) return
    let next: Subscription[] = [...current, [channel, slice]]
    if (next.filter((s) => s[0] === channel).length > MAX_SUBSCRIPTIONS) next = [...next.filter((s) => s[0] !== channel), [channel, null]]
    if (bytesOf(next) > MAX_SLOT_BYTES) next = [...new Set(next.map((s) => s[0]))].map((c): Subscription => [c, null])
    this.save(conn, next)
  }

  unsubscribe(conn: PartyDbConnection, channel: string, slice: SliceValue | null): void {
    const current = this.entries.get(conn.id)?.subscriptions
    if (!current) return
    const key = subscriptionKey(slice)
    const next = current.filter((s) => !(s[0] === channel && keyOf(s) === key))
    if (next.length !== current.length) this.save(conn, next)
  }

  remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    for (const [channel, slice] of entry.subscriptions) {
      const byKey = this.watchers.get(channel)
      const key = subscriptionKey(slice)
      const ids = byKey?.get(key)
      ids?.delete(id)
      if (ids?.size === 0) byKey!.delete(key)
    }
    this.entries.delete(id)
  }

  // the connections watching the whole channel or any of `keys` (subscription keys).
  recipients(channel: string, keys: Iterable<string>): PartyDbConnection[] {
    const byKey = this.watchers.get(channel)
    if (!byKey) return []
    const ids = new Set(byKey.get(subscriptionKey(null)))
    for (const key of keys) for (const id of byKey.get(key) ?? []) ids.add(id)
    return [...ids].map((id) => this.entries.get(id)!.conn)
  }

  // The slot first: if it refuses the write, the index must not claim what a
  // rebuild after the next wake would not find.
  private save(conn: PartyDbConnection, subscriptions: Subscription[]): void {
    conn.saveSubscriptions(subscriptions)
    this.index(conn, subscriptions)
  }

  private index(conn: PartyDbConnection, subscriptions: Subscription[]): void {
    this.remove(conn.id)
    this.entries.set(conn.id, { conn, subscriptions })
    for (const sub of subscriptions) {
      let byKey = this.watchers.get(sub[0])
      if (!byKey) this.watchers.set(sub[0], (byKey = new Map()))
      const key = keyOf(sub)
      let ids = byKey.get(key)
      if (!ids) byKey.set(key, (ids = new Set()))
      ids.add(conn.id)
    }
  }
}
