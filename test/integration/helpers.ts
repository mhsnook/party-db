// Shared fixtures for the miniflare integration tests (sync + auth + reconnect),
// so the URL/room-routing conventions live in one place rather than being copied
// per file.

import { SELF } from 'cloudflare:test'
import { expect, vi } from 'vitest'
import type { SequencedBatch, WriteBatch } from '../../src/protocol.ts'

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

// The `main` party URL for a room, with an optional `?since` cursor. Each test
// uses a distinct room so its Durable Object starts empty.
const url = (room: string, since?: number) =>
  partyUrl('main', room, since === undefined ? {} : { since: String(since) })

// POST a WriteBatch[] to a room over the real HTTP path.
export async function post(room: string, body: unknown): Promise<Response> {
  return SELF.fetch(url(room), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...roomHeader(room) },
    body: JSON.stringify(body),
  })
}

// Open a WebSocket to a room and collect every batch it receives.
export async function connect(room: string, since?: number) {
  const res = await SELF.fetch(url(room, since), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const batches: SequencedBatch[] = []
  ws.addEventListener('message', (e) => batches.push(JSON.parse(e.data as string)))
  const waitFor = (n: number) => vi.waitFor(() => expect(batches.length).toBeGreaterThanOrEqual(n))
  return { ws, batches, waitFor }
}
