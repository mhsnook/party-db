// Turn a (name, schema, key) into a fully-wired TanStack DB collection, and
// expose the ONE thing that is genuinely ours: `persist` — a mutationFn that
// turns a TanStack transaction's mutations into our /write batches and awaits
// seq settlement.
//
// `persist` has the same `({ transaction })` shape TanStack hands to both
// collection handlers and explicit-transaction mutationFns, so it serves both:
//   - per-collection sugar:  collection.insert()  -> onInsert: persist
//   - cross-collection atomic: createTransaction({ mutationFn: persist })
// A single insert is just a one-mutation transaction; many collections become
// many channel-groups in one POST. No new vocabulary — `persist` is the seam.

import { createCollection, type Collection } from '@tanstack/db'
import type { SyncClient } from './sync-client.ts'
import type { WriteBatch, WriteEvent } from '../protocol.ts'
import { definePartyCollection, type PartyCollection } from '../schema.ts'

// The collection interface is shared with the server — one `{ name, key, schema }`
// defined in ../schema.ts, imported on both sides. Re-exported here (plus the
// legacy `PartyCollectionConfig` alias) so client imports keep working.
export { definePartyCollection, type PartyCollection }
export type PartyCollectionConfig<T extends object> = PartyCollection<T>

// What `persist` needs to know about a collection it manages: the channel (= the
// table name) its mutations belong to, and the key column, which an update sends
// alongside its changed columns so the server can locate the row.
export type ChannelBinding = { channel: string; key: string }

// exported for unit tests: a single TanStack mutation → one wire WriteEvent.
//
// An update travels as CHANGED COLUMNS ONLY (`m.changes`) plus the key. TanStack
// tracks which fields the mutation touched, and the server SETs exactly the columns
// present in `value` (`structuredStmt`), so a one-column update leaves every other
// column alone — where sending `m.modified` would write the client's whole copy
// back and revert any column a concurrent writer had changed. Insert and delete
// carry the whole row: an insert has no prior row to preserve, and a delete is
// keyed. See docs/architecture.md §16.
export function toEvent(m: any, key: string): WriteEvent {
  if (m.type === 'delete') return { type: 'delete', value: m.original }
  if (m.type === 'update') {
    return { type: 'update', value: { ...m.changes, [key]: m.modified[key] }, previousValue: m.original }
  }
  return { type: 'insert', value: m.modified }
}

// the irreducible binding: mutations -> grouped-by-channel WriteBatch[] -> POST
// -> await every assigned seq on the down-stream (flicker-free settlement).
// exported so the write path can be tested against a mock SyncClient — it only
// needs `send` + `waitForSeq`, so tests don't stand up a real transport.
export function makePersist(
  client: Pick<SyncClient, 'send' | 'waitForSeq'>,
  bindingOf: Map<Collection<any>, ChannelBinding>,
) {
  return async ({ transaction }: any) => {
    const byChannel = new Map<string, WriteEvent[]>()
    for (const m of transaction.mutations) {
      const binding = bindingOf.get(m.collection)
      if (!binding) continue // a mutation on a collection we don't manage
      const ops = byChannel.get(binding.channel) ?? []
      ops.push(toEvent(m, binding.key))
      byChannel.set(binding.channel, ops)
    }
    const batches: WriteBatch[] = [...byChannel].map(([channel, ops]) => ({ channel, ops }))
    if (!batches.length) return
    const ack = await client.send(batches)
    await Promise.all(ack.accepted.map((a) => client.waitForSeq(a.channel, a.seq)))
  }
}

// internal: wire N collection configs onto one SyncClient. Returns the
// collections plus the shared `persist` mutationFn.
export function wireCollections(client: SyncClient, configs: PartyCollectionConfig<any>[]) {
  const bindingOf = new Map<Collection<any>, ChannelBinding>()
  const persist = makePersist(client, bindingOf)
  const db: Record<string, Collection<any>> = {}
  for (const cfg of configs) {
    const collection = createCollection({
      schema: cfg.schema as any,
      getKey: (item: any) => item[cfg.key],
      sync: { sync: (sink) => client.register(cfg.name, sink) },
      onInsert: persist,
      onUpdate: persist,
      onDelete: persist,
    })
    bindingOf.set(collection, { channel: cfg.name, key: cfg.key })
    db[cfg.name] = collection
  }
  return { db, persist }
}
