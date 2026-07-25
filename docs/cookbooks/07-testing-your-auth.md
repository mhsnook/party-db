# Test your auth

Your `authorize` seam is the one thing standing between the open internet and your
room, so it's worth a test. Because `authHooks` runs it at the *lobby* — before the
request reaches the DO — both doors answer over plain HTTP: an unauthorized read is
a `401` with **no** WebSocket upgrade, and an unauthorized write is a `401`
[`WriteReject`](../../src/protocol.ts). So you can assert the whole gate with
`SELF.fetch` against the real worker in
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) —
no client, no browser. ✅

This assumes a worker that gates both doors, like [recipe 3](./03-external-auth-workos.md)
or [recipe 4](./04-public-read-private-write.md). Swap `TOKEN` for a valid
credential your `authorize` accepts (a signed JWT, a session id) — or hand this file
to your coding agent and let it wire the fixture to your setup.

```ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

// a valid credential your authorize() accepts; a real test mints/signs this
const TOKEN = 's3cret'

// Build a room URL. The connect token rides in ?token= (a browser WS upgrade
// can't set headers); the POST sends it as an Authorization header instead.
const room = (name: string, token?: string) =>
  `https://example.com/parties/main/${name}${token ? `?token=${token}` : ''}`
// partyserver reads the room from the path; under miniflare ctx.id.name isn't
// exposed, so also pass the documented x-partykit-room fallback header.
const header = (name: string) => ({ 'x-partykit-room': name })

const write = (name: string, token?: string) =>
  SELF.fetch(room(name), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...header(name),
    },
    body: JSON.stringify([{ channel: 'todos', ops: [{ type: 'insert', value: { id: 'a', text: 'hi' } }] }]),
  })

describe('the read door (socket open)', () => {
  it('refuses an unauthenticated upgrade with 401, no WebSocket', async () => {
    const res = await SELF.fetch(room('deny-read'), { headers: { Upgrade: 'websocket', ...header('deny-read') } })
    expect(res.status).toBe(401) // rejected at the lobby, before the 101
    expect(res.webSocket).toBeFalsy()
  })

  it('admits an authenticated upgrade', async () => {
    const res = await SELF.fetch(room('allow-read', TOKEN), { headers: { Upgrade: 'websocket', ...header('allow-read') } })
    expect(res.status).toBe(101)
    res.webSocket!.close()
  })
})

describe('the write door (POST)', () => {
  it('rejects an unauthenticated write with 401', async () => {
    expect((await write('deny-write')).status).toBe(401)
  })

  it('rejects a wrong token with 401', async () => {
    expect((await write('wrong-write', 'nope')).status).toBe(401)
  })

  it('accepts an authenticated write', async () => {
    expect((await write('allow-write', TOKEN)).status).toBe(200)
  })
})
```

The `vitest-pool-workers` config points `main` at your worker entry (the one that
calls `routePartykitRequest(req, env, authHooks(authorize))`); see the
[integration setup](../../vitest.integration.config.ts) in this repo for a working
example.

Variations: if you leave `'connect'` open and gate only `'write'`
([recipe 4](./04-public-read-private-write.md)), drop the read-door `401` case and
assert the unauthenticated upgrade still gets `101`. If different parties have
different rules, repeat the block per party name in the URL. To check *who* got in
rather than just that they did, assert on a row your `authorize` stamps with the
caller's id.
