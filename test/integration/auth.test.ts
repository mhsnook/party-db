import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { SECRET } from './worker.ts'
import type { WriteBatch, WriteReject } from '../../src/protocol.ts'

// The `Guarded` party overrides `authorize` to require `SECRET` on both doors:
// the socket open (read) and each POST (write). These tests drive the real
// HTTP + WS path and assert an unauthorized peer is turned away at each door.

// A guarded-party URL. The connect token rides in `?token=` (a browser WS upgrade
// can't set headers); the POST sends it as an Authorization header instead.
const gurl = (room: string, token?: string) =>
  `https://example.com/parties/guarded/${room}${token === undefined ? '' : `?token=${token}`}`

// under miniflare `ctx.id.name` isn't exposed, so pass the room fallback header.
const roomHeader = (room: string) => ({ 'x-partykit-room': room })

const insert = (id: string, text: string): WriteBatch[] => [{ channel: 'todos', ops: [{ type: 'insert', value: { id, text } }] }]

describe('auth gate on the socket open (read)', () => {
  it('closes an unauthorized socket with 1008 and never sends a snapshot', async () => {
    const room = 'auth-connect-deny'
    const res = await SELF.fetch(gurl(room), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    const messages: unknown[] = []
    ws.addEventListener('message', (e) => {
      messages.push(e.data)
    })
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)))
    ws.accept()
    expect(await closed).toBe(1008) // policy violation
    expect(messages).toEqual([]) // turned away before any snapshot
  })

  it('lets an authorized socket read the room', async () => {
    const room = 'auth-connect-allow'
    const res = await SELF.fetch(gurl(room, SECRET), { headers: { Upgrade: 'websocket', ...roomHeader(room) } })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    const first = new Promise<any>((resolve) => ws.addEventListener('message', (e) => resolve(JSON.parse(e.data as string))))
    ws.accept()
    expect(await first).toMatchObject({ channel: 'todos', ready: true }) // got the snapshot
    ws.close()
  })
})

describe('auth gate on the POST (write)', () => {
  async function post(room: string, body: unknown, token?: string): Promise<Response> {
    return SELF.fetch(gurl(room), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...roomHeader(room),
      },
      body: JSON.stringify(body),
    })
  }

  it('rejects an unauthenticated POST with 401 and a WriteReject', async () => {
    const res = await post('auth-write-deny', insert('x', 'one'))
    expect(res.status).toBe(401)
    const body = (await res.json()) as WriteReject
    expect(body.error).toMatch(/unauthorized \(write\)/)
  })

  it('rejects a wrong token with 401', async () => {
    const res = await post('auth-write-wrong', insert('x', 'one'), 'nope')
    expect(res.status).toBe(401)
  })

  it('accepts an authenticated POST', async () => {
    const res = await post('auth-write-allow', insert('x', 'one'), SECRET)
    expect(res.status).toBe(200)
  })
})
