// Shared fixtures for the miniflare integration tests (sync + auth), so the
// URL/room-routing conventions live in one place rather than being copied per file.

import type { WriteBatch } from '../../src/protocol.ts'

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
