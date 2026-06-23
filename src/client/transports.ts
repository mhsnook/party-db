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

// --- Ride-along: Supabase Realtime ------------------------------------------
// down = Supabase Realtime (logical-replication row changes, managed for us)
// up   = supabase-js / PostgREST writes
// No custom server, no custom ack, RLS = auth. Tradeoffs: the Realtime payload
// carries NO lsn/txid, so we settle by primary key (the client-minted UUID),
// not seq; and Realtime does not replay missed events, so reconnect = re-snapshot
// then resume. See unspecified.md → "Supabase ride-along mode".
export function supabaseRealtimeTransport(opts: {
  supabase: any // SupabaseClient
  tables: { name: string; key: string }[]
  schema?: string // default 'public'
}): Transport {
  const keyByTable = new Map(opts.tables.map((t) => [t.name, t.key]))
  return {
    subscribe(onBatch) {
      const channel = opts.supabase.channel('party-db')
      for (const t of opts.tables) {
        channel.on(
          'postgres_changes',
          { event: '*', schema: opts.schema ?? 'public', table: t.name },
          (payload: any) => {
            const type =
              payload.eventType === 'INSERT'
                ? 'insert'
                : payload.eventType === 'UPDATE'
                  ? 'update'
                  : 'delete'
            const value = type === 'delete' ? payload.old : payload.new
            // no seq on the wire — use commit_timestamp as an opaque cursor and
            // settle by primary key. (See unspecified.md.)
            onBatch({ channel: t.name, seq: payload.commit_timestamp, ops: [{ type, value }] })
          },
        )
      }
      channel.subscribe()
      return () => opts.supabase.removeChannel(channel)
    },
    async send(batch) {
      const table = opts.supabase.from(batch.channel)
      const key = keyByTable.get(batch.channel)!
      for (const op of batch.ops) {
        if (op.type === 'insert') await table.insert(op.value)
        else if (op.type === 'update') await table.update(op.value).eq(key, (op.value as any)[key])
        else await table.delete().eq(key, (op.value as any)[key])
      }
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
