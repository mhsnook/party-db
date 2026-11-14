// Who is subscribed to which slice, for a room whose host hands the core its
// connections (`PartyDbCoreOptions.connections`). A write to a sliced channel goes
// to the sockets watching that row's slice, plus the ones watching the whole
// channel — never a loop over every socket (docs/architecture.md §18).
//
// The index lives in memory and dies with the Durable Object's isolate. Each
// connection also keeps its own subscriptions in a slot that survives hibernation
// (`saveSubscriptions`); the first lookup after a wake rebuilds the index from
// those slots, once.

import { sliceText, type SliceValue } from '../protocol.ts'
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

// The 16 KiB hibernation slot holds a few hundred of these. Past the cap, a
// socket's slices of that channel fold into one whole-channel subscription.
export const MAX_SUBSCRIPTIONS = 100

type Entry = { conn: PartyDbConnection; subscriptions: Subscription[] }

export class SliceRoutes {
  private entries = new Map<string, Entry>()
  private whole = new Map<string, Set<string>>()
  private bySlice = new Map<string, Map<string, Set<string>>>()

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

  subscribe(conn: PartyDbConnection, channel: string, slice: SliceValue | null): void {
    const current = this.entries.get(conn.id)?.subscriptions ?? []
    if (current.some((s) => s[0] === channel && (s[1] === null || (slice !== null && sliceText(s[1]) === sliceText(slice))))) return
    let next: Subscription[] = [...current, [channel, slice]]
    if (next.length > MAX_SUBSCRIPTIONS) next = [...next.filter((s) => s[0] !== channel), [channel, null]]
    this.index(conn, next)
    conn.saveSubscriptions(next)
  }

  unsubscribe(conn: PartyDbConnection, channel: string, slice: SliceValue | null): void {
    const entry = this.entries.get(conn.id)
    if (!entry) return
    const next = entry.subscriptions.filter(
      (s) => !(s[0] === channel && (slice === null ? s[1] === null : s[1] !== null && sliceText(s[1]) === sliceText(slice))),
    )
    if (next.length === entry.subscriptions.length) return
    this.index(conn, next)
    conn.saveSubscriptions(next)
  }

  remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    for (const [channel, slice] of entry.subscriptions) {
      const set = this.setOf(channel, slice)
      set.delete(id)
      if (set.size === 0 && slice !== null) this.bySlice.get(channel)!.delete(sliceText(slice))
    }
    this.entries.delete(id)
  }

  // the connections watching any of `slices` on `channel`, or the whole channel.
  recipients(channel: string, slices: Iterable<string>): PartyDbConnection[] {
    const ids = new Set(this.whole.get(channel))
    const byText = this.bySlice.get(channel)
    if (byText) for (const text of slices) for (const id of byText.get(text) ?? []) ids.add(id)
    return [...ids].map((id) => this.entries.get(id)!.conn)
  }

  private index(conn: PartyDbConnection, subscriptions: Subscription[]): void {
    this.remove(conn.id)
    this.entries.set(conn.id, { conn, subscriptions })
    for (const [channel, slice] of subscriptions) this.setOf(channel, slice).add(conn.id)
  }

  private setOf(channel: string, slice: SliceValue | null): Set<string> {
    if (slice === null) {
      let set = this.whole.get(channel)
      if (!set) this.whole.set(channel, (set = new Set()))
      return set
    }
    let byText = this.bySlice.get(channel)
    if (!byText) this.bySlice.set(channel, (byText = new Map()))
    const text = sliceText(slice)
    let set = byText.get(text)
    if (!set) byText.set(text, (set = new Set()))
    return set
  }
}
