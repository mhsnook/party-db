// The headline client API. Build a transport once, hand it your collection
// configs, get back live TanStack DB collections. That's the whole surface.

import PartySocket from 'partysocket'
import { SyncClient, type Transport, type SyncClientOptions } from './sync-client.ts'
import { wireCollections, type PartyCollectionConfig } from './collection.ts'
import { WriteError, TransportError, AuthError, toWriteReject } from './errors.ts'
import { isSequencedBatch, PROTO_PARAM, PROTO_VALUE, type SequencedBatch } from '../protocol.ts'

// WebSocket close code the server uses when a room-aware auth check rejects the
// connection (docs/auth.md §2). Unlike 1006 (network) / 1011 (server) / normal,
// re-dialing can't fix it — the same token loops — so we treat it as terminal.
const CLOSE_POLICY_VIOLATION = 1008

// Decode one socket frame, or null if it isn't ours. A composed host shares the
// room's socket (docs/architecture.md §15), so the stream carries frames party-db
// did not send: binary, text that isn't JSON, or JSON with no channel to route by.
// Dropping them here keeps a foreign frame from moving the cursor (#48). We skip
// the parse on a binary frame rather than pay for the SyntaxError it would throw.
function parseFrame(data: unknown): SequencedBatch | null {
  if (typeof data !== 'string') return null
  try {
    const frame: unknown = JSON.parse(data)
    return isSequencedBatch(frame) ? frame : null
  } catch {
    return null
  }
}

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
  // consumers waiting to hear that the down path was auth-rejected (1008). We
  // fan out to a set so an app can register a handler without racing construction.
  const authListeners = new Set<(error: AuthError) => void>()
  const socket = new PartySocket({
    host: opts.host,
    room: opts.room,
    party,
    // re-evaluated on every (re)connect: ask only for what we missed, and carry
    // the token in the query since a WS upgrade can't set headers. The proto
    // marker lets a host that serves other traffic on the same room recognize
    // party-db requests (docs/architecture.md §15); a PartyDbServer ignores it.
    query: () => {
      const token = tokenOf()
      return {
        [PROTO_PARAM]: PROTO_VALUE,
        ...(lastSeq === undefined ? {} : { since: String(lastSeq) }),
        ...(token ? { token } : {}),
      }
    },
    // a 1008 (policy violation) close is the server's auth verdict on the socket:
    // stop PartySocket re-dialing (it would just close-reconnect-close in a loop).
    // Every other code keeps the default reconnect (1006 network, 1011 server, …).
    shouldReconnectOnClose: (event) => event.code !== CLOSE_POLICY_VIOLATION,
  })
  // ...and surface it, so the app can prompt re-auth instead of watching a silent
  // dead socket. shouldReconnectOnClose above already ran on this same event, so
  // by the time we notify, the reconnect has been suppressed.
  socket.addEventListener('close', (event) => {
    if (event.code !== CLOSE_POLICY_VIOLATION) return
    const error = new AuthError(event.reason || 'websocket closed by server auth policy (1008)', event.code)
    for (const listener of authListeners) listener(error)
  })
  return {
    subscribe(onBatch) {
      const handler = (e: MessageEvent) => {
        const batch = parseFrame(e.data)
        if (!batch) return
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
          { host: opts.host, room: opts.room, party, query: { [PROTO_PARAM]: PROTO_VALUE } },
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
    onAuthError(listener) {
      authListeners.add(listener)
      return () => authListeners.delete(listener)
    },
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
    // subscribe to a terminal auth rejection on the down-stream (a 1008 close):
    // the transport has stopped reconnecting, so re-auth is the app's move. No-op
    // (and an inert unsubscribe) for a transport without an auth-gated down path.
    onAuthError(listener: (error: AuthError) => void): () => void {
      return transport.onAuthError?.(listener) ?? (() => {})
    },
  }
}
