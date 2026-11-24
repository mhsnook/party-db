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
import { DroppedError } from './errors.ts'
import type { WriteBatch, WriteEvent } from '../protocol.ts'
import { definePartyCollection, type PartyCollection } from '../schema.ts'

// The collection interface is shared with the server — one `{ name, key, schema }`
// defined in ../schema.ts, imported on both sides. Re-exported here (plus the
// legacy `PartyCollectionConfig` alias) so client imports keep working.
export { definePartyCollection, type PartyCollection }
export type PartyCollectionConfig<T extends object, Name extends string = string> = PartyCollection<T, Name>

// The TanStack collection a config becomes: its row type, keyed by the type of its
// key column (TanStack's `string | number` when the column can't be told).
type KeyOf<T, K> = K extends keyof T ? (T[K] extends string | number ? T[K] : string | number) : string | number
type CollectionOf<C> = C extends PartyCollection<infer T, string, infer K> ? Collection<T, KeyOf<T, K>> : never

// Configs whose name TypeScript kept as a literal, keyed by that name.
type Named<C extends readonly PartyCollection<any, string>[]> = {
  [K in C[number] as string extends K['name'] ? never : K['name']]: CollectionOf<K>
}

// `db`, typed by collection name. A config whose name widened to `string` (an
// explicit `definePartyCollection<Row>(...)`, or a config built at runtime) can't be
// keyed, so `db` also accepts any name as `Collection<any>`, which is what every
// collection was before names were typed.
export type DbOf<C extends readonly PartyCollection<any, string>[]> = string extends C[number]['name']
  ? Named<C> & { [name: string]: Collection<any> }
  : Named<C>

// exported for unit tests: a single TanStack mutation → one wire WriteEvent.
// An update sends the fields it changed plus the key, never the whole row (§16).
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
  // each managed collection's own config: `name` is the channel, `key` the column
  // an update sends alongside its changed ones.
  configOf: WeakMap<Collection<any>, PartyCollection<any>>,
  // collections a reset replaced: a write to one would POST as whoever is signed in now
  retired?: WeakSet<Collection<any>>,
) {
  return async ({ transaction }: any) => {
    const byChannel = new Map<string, WriteEvent[]>()
    for (const m of transaction.mutations) {
      if (retired?.has(m.collection)) throw new DroppedError('this collection was replaced by a reset: write to the one now in `db`')
      const cfg = configOf.get(m.collection)
      if (!cfg) continue // a mutation on a collection we don't manage
      const ops = byChannel.get(cfg.name) ?? []
      ops.push(toEvent(m, cfg.key))
      byChannel.set(cfg.name, ops)
    }
    const batches: WriteBatch[] = [...byChannel].map(([channel, ops]) => ({ channel, ops }))
    if (!batches.length) return
    const ack = await client.send(batches)
    await Promise.all(ack.accepted.map((a) => client.waitForSeq(a.channel, a.seq)))
  }
}

// internal: wire N collection configs onto one SyncClient. Returns the
// collections plus the shared `persist` mutationFn.
export function wireCollections(client: SyncClient, configs: readonly PartyCollectionConfig<any>[]) {
  // weak: we only ever look a collection up by identity, so this must not be the
  // thing keeping every collection (and its rows) alive.
  const configOf = new WeakMap<Collection<any>, PartyCollection<any>>()
  const retired = new WeakSet<Collection<any>>()
  const persist = makePersist(client, configOf, retired)
  const db: Record<string, Collection<any>> = {}
  const build = (cfg: PartyCollectionConfig<any>) => {
    const sliceBy = cfg.sliceBy
    const collection = createCollection({
      schema: cfg.schema as any,
      getKey: (item: any) => item[cfg.key],
      // a sliced collection loads what its live queries ask for (§18)
      syncMode: sliceBy === undefined ? 'eager' : 'on-demand',
      sync: {
        sync: (params) =>
          sliceBy === undefined
            ? client.register(cfg.name, params)
            : client.registerSliced(cfg.name, params, { column: sliceBy, rows: () => params.collection.entries() }),
      },
      onInsert: persist,
      onUpdate: persist,
      onDelete: persist,
    })
    configOf.set(collection, cfg)
    return collection
  }
  for (const cfg of configs) {
    if (cfg.sliceBy !== undefined) client.declareSliced(cfg.name)
    db[cfg.name] = build(cfg)
  }
  // After a reset emptied every collection: put a fresh one in each one's place.
  // It syncs when a query first reads it, and loads from a snapshot.
  const renew = () => {
    for (const cfg of configs) {
      const old = db[cfg.name]
      retired.add(old)
      db[cfg.name] = build(cfg)
      void old.cleanup()
    }
  }
  return { db, persist, renew }
}
