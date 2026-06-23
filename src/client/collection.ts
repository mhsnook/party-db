// The DX layer. Turn a (name, schema, key) into a fully-wired TanStack DB
// collection: getKey, the sync() that registers on the shared SyncClient, and
// the onInsert/onUpdate/onDelete handlers — which are just thin wrappers that
// emit WriteEvents and push them up the wire.
//
// Almost everything here is *derived*. See unspecified.md → "Config derivation".

import { createCollection, type Collection } from '@tanstack/db'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { SyncClient } from './sync-client.ts'
import type { WriteEvent } from '../protocol.ts'

export type PartyCollectionConfig<T extends object> = {
  name: string // channel === table name
  key: keyof T & string // primary key field → getKey
  // shared zod/StandardSchema: gives types + client-side validation. The server
  // can import the very same one. Optional: omit for an untyped/dynamic table.
  schema?: StandardSchemaV1<T>
  // optional narrower shapes for write-time validation; default to `schema`.
  insertSchema?: StandardSchemaV1<Partial<T>>
  updateSchema?: StandardSchemaV1<Partial<T>>
}

export function definePartyCollection<T extends object>(cfg: PartyCollectionConfig<T>) {
  return cfg
}

// Map a TanStack DB transaction → WriteEvents and push them up.
//
// CONTROLLED MODE: `persist` should not resolve until the assigned seq has come
// back down the stream (Electric-style awaitTxId), so the optimistic overlay
// survives the ack→stream gap. Marked TODO — see unspecified.md → "Two-phase
// pending". TRUSTING MODE: resolve on send; the optimistic overlay is dropped
// and the echo reconciles it.
function handlersFor<T extends object>(client: SyncClient, channel: string) {
  const persist = (ops: WriteEvent<T>[]) => client.send(channel, ops)
  return {
    onInsert: ({ transaction }: any) =>
      persist(transaction.mutations.map((m: any) => ({ type: 'insert', value: m.modified }))),
    onUpdate: ({ transaction }: any) =>
      persist(
        transaction.mutations.map((m: any) => ({
          type: 'update',
          value: m.modified,
          previousValue: m.original,
        })),
      ),
    onDelete: ({ transaction }: any) =>
      persist(transaction.mutations.map((m: any) => ({ type: 'delete', value: m.original }))),
  }
}

// Wire N collections onto one transport. This is the headline API.
export function createPartyDb<C extends PartyCollectionConfig<any>[]>(
  client: SyncClient,
  configs: C,
) {
  const db: Record<string, Collection<any>> = {}
  for (const cfg of configs) {
    db[cfg.name] = createCollection({
      schema: cfg.schema as any,
      getKey: (item: any) => item[cfg.key],
      sync: { sync: (sink) => client.register(cfg.name, sink) },
      ...handlersFor(client, cfg.name),
    })
  }
  return { db }
}
