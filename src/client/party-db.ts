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
  const socket = new PartySocket({ host: opts.host, room: opts.room, party })
  const local = /^(localhost|127\.|\[?::1)/.test(opts.host)
  const writeUrl = `${local ? 'http' : 'https'}://${opts.host}/parties/${party}/${opts.room}`
  return {
    subscribe(onBatch) {
      const handler = (e: MessageEvent) => onBatch(JSON.parse(e.data) as SequencedBatch)
      socket.addEventListener('message', handler)
      return () => socket.removeEventListener('message', handler)
    },
    async send(batch) {
      const res = await fetch(writeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([batch]),
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
  const db = wireCollections(client, configs)
  return {
    db,
    client,
    get isConnecting() {
      return client.isConnecting()
    },
  }
}
