// The headline client API. Build a transport once, hand it your collection
// configs, get back live TanStack DB collections. That's the whole surface.

import PartySocket from 'partysocket'
import { SyncClient, type Transport } from './sync-client.ts'
import { wireCollections, type PartyCollectionConfig } from './collection.ts'
import type { SequencedBatch } from '../protocol.ts'

// The DO / PartyKit transport: down = the partysocket (hibernatable WS on the
// server), up = POST to the same room (so the socket can hibernate).
export function partyTransport(opts: { host: string; room: string; party?: string }): Transport {
  const party = opts.party ?? 'main'
  let lastSeq: number | undefined // highest seq applied; drives delta reconnect
  const socket = new PartySocket({
    host: opts.host,
    room: opts.room,
    party,
    // re-evaluated on every (re)connect: ask only for what we missed.
    query: () => (lastSeq === undefined ? {} : { since: String(lastSeq) }),
  })
  // match the page's scheme (https page -> https write URL); default to https off-browser.
  const scheme = typeof location !== 'undefined' && location.protocol === 'http:' ? 'http' : 'https'
  const writeUrl = `${scheme}://${opts.host}/parties/${party}/${opts.room}`
  return {
    subscribe(onBatch) {
      const handler = (e: MessageEvent) => {
        const batch = JSON.parse(e.data) as SequencedBatch
        if (typeof batch.seq === 'number') lastSeq = Math.max(lastSeq ?? 0, batch.seq)
        onBatch(batch)
      }
      socket.addEventListener('message', handler)
      return () => socket.removeEventListener('message', handler)
    },
    async send(batches) {
      const res = await fetch(writeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batches),
      })
      if (!res.ok) throw new Error(`write failed: ${res.status} ${await res.text()}`)
      return res.json()
    },
    isConnecting: () => socket.readyState === socket.CONNECTING,
  }
}

export function createPartyDb<C extends PartyCollectionConfig<any>[]>(
  transport: Transport,
  configs: C,
) {
  const client = new SyncClient(transport)
  const { db, persist } = wireCollections(client, configs)
  return {
    db,
    // the mutationFn for cross-collection atomic writes via TanStack's
    // documented createTransaction({ mutationFn: persist }).
    persist,
    client,
    get isConnecting() {
      return transport.isConnecting?.() ?? false
    },
  }
}
