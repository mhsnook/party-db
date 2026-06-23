// Transport sketches. Each is a thin adapter to the Transport interface; the
// SyncClient and the interpreter never change between them.
//
// Status: SKETCHES. They show the down/up split per deploy target, not a
// finished impl. See unspecified.md → "Transport matrix".

import type { Transport } from './sync-client.ts'
import type { SequencedBatch, WriteAck, WriteBatch } from '../protocol.ts'

// --- Target 1: Durable Object -----------------------------------------------
// down = hibernatable WebSocket (cheap to hold open for many idle clients)
// up   = POST /write (so the socket can hibernate; gives a clean ack response)
export function durableObjectTransport(opts: {
  socket: WebSocket // a partysocket, already opened to host+room
  writeUrl: string // POST endpoint for the same room
  headers?: () => Record<string, string> // auth (bearer/session)
}): Transport {
  return {
    subscribe(onBatch) {
      const handler = (e: MessageEvent) => onBatch(JSON.parse(e.data) as SequencedBatch)
      opts.socket.addEventListener('message', handler)
      return () => opts.socket.removeEventListener('message', handler)
    },
    async send(batch: WriteBatch) {
      const res = await fetch(opts.writeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers?.() },
        body: JSON.stringify(batch),
      })
      return (await res.json()) as WriteAck
    },
  }
}

// --- Target 2: PostgREST / Supabase Edge ------------------------------------
// down = SSE, up = POST /write (a small handler that turns WriteEvents into
// PostgREST POST/PATCH/DELETE, or runs them directly against Postgres).
export function postgrestTransport(opts: {
  streamUrl: string // SSE endpoint for the room/subscription
  writeUrl: string
  headers?: () => Record<string, string>
}): Transport {
  return {
    subscribe(onBatch) {
      const es = new EventSource(opts.streamUrl)
      es.onmessage = (e) => onBatch(JSON.parse(e.data) as SequencedBatch)
      return () => es.close()
    },
    async send(batch: WriteBatch) {
      const res = await fetch(opts.writeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers?.() },
        body: JSON.stringify(batch),
      })
      return (await res.json()) as WriteAck
    },
  }
}

// --- Trusting mode: WS-only -------------------------------------------------
// up and down over the same socket; no ack, client trusts its gut (and mints
// UUIDs before sending). Cheapest, least safe.
export function trustingSocketTransport(socket: WebSocket): Transport {
  return {
    subscribe(onBatch) {
      const handler = (e: MessageEvent) => onBatch(JSON.parse(e.data) as SequencedBatch)
      socket.addEventListener('message', handler)
      return () => socket.removeEventListener('message', handler)
    },
    async send(batch: WriteBatch) {
      socket.send(JSON.stringify(batch))
    },
  }
}
