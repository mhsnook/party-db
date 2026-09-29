import type { Collection } from '@tanstack/react-db'
import { DeleteOperationItemNotFoundError, queryCollectionOptions, type QueryCollectionUtils } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'
import PartySocket from 'partysocket'
import type { Frame } from './protocol'

type Key = string | number

export type ServerCollectionConfig<T extends object, K extends Key> = {
  /** The realtime channel this collection listens to; also its query key. */
  name: string
  queryClient: QueryClient
  getKey: (row: T) => K
  list: () => Promise<T[]>
  insert?: (row: T) => Promise<T>
  update?: (key: K, changes: Partial<T>) => Promise<T>
  remove?: (key: K) => Promise<unknown>
}

/**
 * A TanStack DB collection over your own server functions. Each handler writes the row the
 * server returned into the synced store, so the optimistic row settles without a refetch.
 */
export function serverCollectionOptions<T extends object, K extends Key>(config: ServerCollectionConfig<T, K>) {
  const { name, queryClient, getKey, list, insert, update, remove } = config
  return queryCollectionOptions({
    id: name,
    queryKey: [name],
    queryFn: list,
    queryClient,
    getKey,
    onInsert: insert
      ? async ({ transaction, collection }) => {
          const rows = await Promise.all(transaction.mutations.map((m) => insert(m.modified)))
          collection.utils.writeUpsert(rows)
          return { refetch: false }
        }
      : undefined,
    onUpdate: update
      ? async ({ transaction, collection }) => {
          const rows = await Promise.all(transaction.mutations.map((m) => update(m.key as K, m.changes)))
          collection.utils.writeUpsert(rows)
          return { refetch: false }
        }
      : undefined,
    onDelete: remove
      ? async ({ transaction, collection }) => {
          await Promise.all(transaction.mutations.map((m) => remove(m.key as K)))
          deleteSynced(collection.utils as QueryCollectionUtils<T, K>, transaction.mutations.map((m) => m.key as K))
          return { refetch: false }
        }
      : undefined,
  })
}

type SyncedCollection = Pick<Collection<any, any>, 'status' | 'onFirstReady' | 'keys'> & {
  utils: QueryCollectionUtils<any, any, any, any>
}

/** The echo of a delete often lands after the handler already removed the row, so a missing key is not an error. */
function deleteSynced(utils: QueryCollectionUtils<any, any, any, any>, keys: Key[]) {
  for (const key of keys) {
    try {
      utils.writeDelete(key)
    } catch (e) {
      if (!(e instanceof DeleteOperationItemNotFoundError)) throw e
    }
  }
}

// not writeBatch: a batch validates every delete at the end, so one already-gone key would drop the frame
function apply(collection: SyncedCollection, frame: Frame) {
  if (frame.upsert?.length) collection.utils.writeUpsert(frame.upsert)
  if (frame.delete?.length) deleteSynced(collection.utils, frame.delete)
}

export type RealtimeOptions = {
  room: string
  channels: Record<string, SyncedCollection>
  /** The kebab-cased Durable Object binding name. */
  party?: string
  host?: string
}

/**
 * Keep collections live from one socket. After a reconnect each loaded collection reloads once,
 * since frames sent while the socket was down are gone.
 */
export function connectRealtime({ room, channels, party = 'realtime', host = location.host }: RealtimeOptions) {
  const socket = new PartySocket({ host, party, room })
  // a load's result replaces the whole collection, so a frame applied while a load is in flight
  // would be erased by a snapshot taken before it; hold those frames until the load lands
  const held = new Map<string, Frame[]>()

  const hold = (channel: string, until: Promise<unknown>) => {
    if (held.has(channel)) return
    held.set(channel, [])
    void until.finally(() => {
      const frames = held.get(channel) ?? []
      held.delete(channel)
      for (const frame of frames) apply(channels[channel]!, frame)
    })
  }

  /** Reload every collection that has loaded, holding frames until each load lands. */
  const reload = () => {
    for (const [channel, collection] of Object.entries(channels)) {
      if (collection.status === 'ready') hold(channel, collection.utils.refetch())
    }
  }

  let connectedBefore = false
  socket.addEventListener('open', () => {
    if (connectedBefore) reload()
    connectedBefore = true
  })

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    const frame = JSON.parse(event.data) as Frame
    const collection = channels[frame.channel]
    if (!collection) return
    if (collection.status === 'loading' && !held.has(frame.channel)) {
      hold(frame.channel, new Promise<void>((resolve) => collection.onFirstReady(resolve)))
    }
    const pending = held.get(frame.channel)
    if (pending) pending.push(frame)
    // an idle collection has never loaded; its first load will read this row from the database
    else if (collection.status === 'ready') apply(collection, frame)
  })

  return { close: () => socket.close(), reload }
}

export type AppConfig<C extends Record<string, SyncedCollection>, Extra> = {
  queryClient: QueryClient
  collections: C
  /** Which realtime room a signed-in user listens to. Defaults to one room per user. */
  roomOf?: (userId: string) => string
} & Extra

/**
 * One object for the whole backend: your API client, auth client and collections, plus the realtime
 * socket. Call `setUser` whenever the signed-in user changes; it drops the old user's rows.
 */
export function createApp<C extends Record<string, SyncedCollection>, Extra extends object>(config: AppConfig<C, Extra>) {
  const { collections, roomOf = (id: string) => id } = config
  let current: { userId: string; close: () => void } | null = null

  return {
    ...config,
    db: collections,
    setUser(userId: string | null) {
      if ((current?.userId ?? null) === userId) return
      current?.close()
      current = null
      if (!userId) {
        // not cleanup(): mounted live queries still hold the collections, and a cleaned-up source breaks them
        for (const c of Object.values(collections)) deleteSynced(c.utils, [...c.keys()])
        return
      }
      const realtime = connectRealtime({ room: roomOf(userId), channels: collections })
      realtime.reload()
      current = { userId, close: realtime.close }
    },
  }
}
