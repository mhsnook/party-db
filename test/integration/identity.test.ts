// The server-layer identity gate — `auth`, fail-closed by default — proven end to
// end through a Durable Object, on plain DO-SQLite so it needs no Postgres and
// always runs. With `auth` set and no `anonRole` latch, an anonymous write is
// rejected BEFORE any transaction opens, rather than running identity-less — the
// behavior that also protects the Postgres privileged-connection footgun. (Real RLS
// ENFORCEMENT with the injected identity is the Postgres lane, pg.test.ts.)

import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import type { WriteAck, WriteBatch } from '../../src/protocol.ts'
import { partyUrl, roomHeader } from './helpers.ts'

const url = (room: string) => partyUrl('authed', room, {})
const write = (id: string): WriteBatch[] => [{ channel: 'todos', ops: [{ type: 'insert', value: { id, text: 'x' } }] }]

async function post(room: string, token?: string): Promise<Response> {
  return SELF.fetch(url(room), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...roomHeader(room),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(write(`${room}-1`)),
  })
}

describe('server identity gate (auth set, no anonRole → fail-closed)', () => {
  it('a valid token resolves an identity and the write succeeds (200)', async () => {
    const res = await post('id-ok', 'alice')
    expect(res.status).toBe(200)
    const ack = (await res.json()) as WriteAck
    expect(ack.accepted).toEqual([{ channel: 'todos', seq: 1 }])
  })

  it('an anonymous write (no token → no identity) is rejected 401 before any transaction', async () => {
    const res = await post('id-anon') // no anonRole latch → anonymous is refused
    expect(res.status).toBe(401)
  })

  it('a verifier that throws is an auth failure → 401', async () => {
    const res = await post('id-boom', 'boom')
    expect(res.status).toBe(401)
  })
})
