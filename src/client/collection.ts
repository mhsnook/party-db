// Turn a (name, schema, key) into a fully-wired TanStack DB collection: getKey,
// the sync() that registers on the shared SyncClient, and the
// onInsert/onUpdate/onDelete handlers — which are just thin wrappers that emit
// WriteEvents up the wire and then await settlement.

import { createCollection, type Collection } from '@tanstack/db'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { SyncClient } from './sync-client.ts'
import type { WriteEvent } from '../protocol.ts'

export type PartyCollectionConfig<T extends object> = {
  name: string // channel === table name
  key: keyof T & string // primary key field → getKey
  schema?: StandardSchemaV1<T> // shared zod/StandardSchema: types + validation
}

export function definePartyCollection<T extends object>(cfg: PartyCollectionConfig<T>) {
  return cfg
}

// onInsert/onUpdate/onDelete → WriteEvents → POST → await the assigned seq on the
// stream before resolving. Resolving on settlement (not on the bare ack) keeps
// the optimistic overlay through the "acked-but-not-streamed" window, so it drops
// straight onto the synced row with no flicker.
function handlersFor<T extends object>(client: SyncClient, channel: string) {
  const persist = async (ops: WriteEvent<T>[]) => {
    const ack = await client.send(channel, ops)
    await Promise.all(ack.accepted.map((a) => client.waitForSeq(a.channel, a.seq)))
  }
  const toEvent = (type: WriteEvent<T>['type'], m: any): WriteEvent<T> =>
    type === 'delete'
      ? { type, value: m.original }
      : type === 'update'
        ? { type, value: m.modified, previousValue: m.original }
        : { type, value: m.modified }
  const handler = (type: WriteEvent<T>['type']) => ({ transaction }: any) =>
    persist(transaction.mutations.map((m: any) => toEvent(type, m)))
  return { onInsert: handler('insert'), onUpdate: handler('update'), onDelete: handler('delete') }
}

// internal: wire N collection configs onto one SyncClient.
export function wireCollections(client: SyncClient, configs: PartyCollectionConfig<any>[]) {
  const db: Record<string, Collection<any>> = {}
  for (const cfg of configs) {
    db[cfg.name] = createCollection({
      schema: cfg.schema as any,
      getKey: (item: any) => item[cfg.key],
      sync: { sync: (sink) => client.register(cfg.name, sink) },
      ...handlersFor(client, cfg.name),
    })
  }
  return db
}
