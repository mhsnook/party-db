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
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { SyncClient } from './sync-client.ts'
import type { WriteBatch, WriteEvent } from '../protocol.ts'

export type PartyCollectionConfig<T extends object> = {
  name: string // channel === table name
  key: keyof T & string // primary key field → getKey
  schema?: StandardSchemaV1<T> // shared zod/StandardSchema: types + validation
}

export function definePartyCollection<T extends object>(cfg: PartyCollectionConfig<T>) {
  return cfg
}

// exported for unit tests: a single TanStack mutation → one wire WriteEvent.
export function toEvent(m: any): WriteEvent {
  if (m.type === 'delete') return { type: 'delete', value: m.original }
  if (m.type === 'update') return { type: 'update', value: m.modified, previousValue: m.original }
  return { type: 'insert', value: m.modified }
}

// the irreducible binding: mutations -> grouped-by-channel WriteBatch[] -> POST
// -> await every assigned seq on the down-stream (flicker-free settlement).
// exported so the write path can be tested against a mock SyncClient — it only
// needs `send` + `waitForSeq`, so tests don't stand up a real transport.
export function makePersist(
  client: Pick<SyncClient, 'send' | 'waitForSeq'>,
  channelOf: Map<Collection<any>, string>,
) {
  return async ({ transaction }: any) => {
    const byChannel = new Map<string, WriteEvent[]>()
    for (const m of transaction.mutations) {
      const channel = channelOf.get(m.collection)
      if (!channel) continue // a mutation on a collection we don't manage
      const ops = byChannel.get(channel) ?? []
      ops.push(toEvent(m))
      byChannel.set(channel, ops)
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
  const channelOf = new Map<Collection<any>, string>()
  const persist = makePersist(client, channelOf)
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
    channelOf.set(collection, cfg.name)
    db[cfg.name] = collection
  }
  return { db, persist }
}
