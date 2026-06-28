// The headline client API. Build a transport once, hand it your collection
// configs, get back live TanStack DB collections. That's the whole surface.

import PartySocket from 'partysocket'
import { SyncClient, type Transport, type SyncClientOptions } from './sync-client.ts'
import { wireCollections, type PartyCollectionConfig } from './collection.ts'
import { WriteError, TransportError, toWriteReject } from './errors.ts'
import type { SequencedBatch } from '../protocol.ts'

// The DO / PartyKit transport: down = the partysocket (hibernatable WS on the
// server), up = POST to the same room (so the socket can hibernate).
export function partyTransport(opts: {
  host: string
  room: string
  party?: string
  // optional credential for auth-gated rooms: `Authorization: Bearer <token>` on
  // the POST, `?token=<token>` on the connect (a WS upgrade can't set headers). A
  // function is re-read on every (re)connect / write, so a refreshed token sticks.
  token?: string | (() => string | undefined)
}): Transport {
  const party = opts.party ?? 'main'
  const tokenOf = () => (typeof opts.token === 'function' ? opts.token() : opts.token)
  let lastSeq: number | undefined // highest seq applied; drives delta reconnect
  const socket = new PartySocket({
    host: opts.host,
    room: opts.room,
    party,
    // re-evaluated on every (re)connect: ask only for what we missed, and carry
    // the token in the query since a WS upgrade can't set headers.
    query: () => {
      const token = tokenOf()
      return {
        ...(lastSeq === undefined ? {} : { since: String(lastSeq) }),
        ...(token ? { token } : {}),
      }
    },
  })
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
      // PartySocket.fetch builds the party URL for us (host/scheme/route) — the
      // same room the socket is connected to.
      const token = tokenOf()
      let res: Awaited<ReturnType<typeof PartySocket.fetch>>
      try {
        res = await PartySocket.fetch(
          { host: opts.host, room: opts.room, party },
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(batches),
          },
        )
      } catch (cause) {
        // the POST never got a response (offline, DNS, reset) — distinct from a
        // server verdict, and retriable.
        throw new TransportError('write request did not reach the server', { cause })
      }
      if (!res.ok) throw new WriteError(res.status, await toWriteReject(res))
      return res.json()
    },
    isConnecting: () => socket.readyState === socket.CONNECTING,
  }
}

export function createPartyDb<C extends PartyCollectionConfig<any>[]>(
  transport: Transport,
  configs: C,
  options?: SyncClientOptions,
) {
  const client = new SyncClient(transport, options)
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
