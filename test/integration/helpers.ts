// Shared fixtures for the miniflare integration tests (sync + auth + reconnect),
// so the URL/room-routing conventions live in one place rather than being copied
// per file.

import { SELF } from 'cloudflare:test'
import { expect, vi } from 'vitest'
import type { Transport } from '../../src/client/sync-client.ts'
import type { SequencedBatch, UpFrame, WriteAck, WriteBatch } from '../../src/protocol.ts'

// Build a party URL: `https://example.com/parties/<party>/<room>?<query>`.
export const partyUrl = (party: string, room: string, query: Record<string, string> = {}) => {
  const qs = new URLSearchParams(query).toString()
  return `https://example.com/parties/${party}/${room}${qs ? `?${qs}` : ''}`
}

// partyserver names the room from the URL path; under miniflare `ctx.id.name`
// isn't exposed, so we also pass the documented `x-partykit-room` fallback header.
export const roomHeader = (room: string) => ({ 'x-partykit-room': room })

export const insert = (id: string, text: string): WriteBatch[] => [
  { channel: 'todos', ops: [{ type: 'insert', value: { id, text } }] },
]

// A party URL for a room (the `main` party unless named), with an optional
// `?since` cursor. Each test uses a distinct room so its Durable Object starts empty.
const url = (room: string, since?: number, party = 'main') =>
  partyUrl(party, room, since === undefined ? {} : { since: String(since) })

// POST a WriteBatch[] to a room over the real HTTP path.
export async function post(room: string, body: unknown, party = 'main'): Promise<Response> {
  return SELF.fetch(url(room, undefined, party), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...roomHeader(room) },
    body: JSON.stringify(body),
  })
}

// Open a WebSocket to a room and collect every batch it receives.
export async function connect(room: string, since?: number, party = 'main') {
  const res = await SELF.fetch(url(room, since, party), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const batches: SequencedBatch[] = []
  ws.addEventListener('message', (e) => batches.push(JSON.parse(e.data as string)))
  const waitFor = (n: number) => vi.waitFor(() => expect(batches.length).toBeGreaterThanOrEqual(n))
  return { ws, batches, waitFor }
}

// A `Transport` over the test worker: partysocket can't dial `SELF`, so the
// down-stream is a raw test WebSocket and the up-path is `post`. Everything above
// it — SyncClient, the collection, `persist` — is the real client. `sent` records
// every frame the client sends up the socket.
export async function workerTransport(room: string, party = 'main') {
  const socket = await connect(room, undefined, party)
  const sent: UpFrame[] = []
  const listeners = new Set<(batch: SequencedBatch) => void>()
  socket.ws.addEventListener('message', (e) => {
    const batch = JSON.parse(e.data as string) as SequencedBatch
    for (const listener of listeners) listener(batch)
  })
  const transport: Transport = {
    subscribe(onBatch) {
      listeners.add(onBatch)
      return () => listeners.delete(onBatch)
    },
    async send(batches) {
      const res = await post(room, batches, party)
      if (!res.ok) throw new Error(`write rejected: ${res.status}`)
      return (await res.json()) as WriteAck
    },
    sendFrame(frame) {
      sent.push(frame)
      socket.ws.send(JSON.stringify(frame))
    },
  }
  return { ...socket, transport, sent }
}

// A collection's (or live query's) row ids, sorted.
export const ids = (collection: { toArray: ReadonlyArray<{ id: string }> }) => collection.toArray.map((row) => row.id).sort()
