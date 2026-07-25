# Test your auth

PartyDB has its own tests, but it leaves some of the server setup and config up to
you — it's just JavaScript, with no new API to learn. So you can follow our example
code (it's all covered by our own tests), but if you diverge from these documented
patterns — and even if you don't — you'll probably want your own tests, to be sure
you haven't "just JavaScript"ed your way into a security hole.

Your auth gate is the one thing standing between the open internet and your room, so
it's the first thing worth testing — and it's a mix of what we ship and what you
write. Knowing which is which tells you what your test can rely on:

**API — shipped by `party-db/server`, the contract is fixed:**

- `authHooks(authorize)`, `getTokenFromRequest(req)`, `bearer(req)` — functions you import.
- `Authorize`, `AuthContext`, `AuthDecision`, `AuthKind` — the types your `authorize` is written against; [`WriteReject`](../../src/protocol.ts) — the rejected-write body.
- **Guaranteed behavior:** a request `authHooks` gates and `authorize` rejects is refused at the *lobby*, before the DO wakes — a `401` with **no** WebSocket upgrade on connect, a `401` `WriteReject` on write. This is what your assertions lean on, and it holds for any `authorize` you write.

**Convention — our shape, but just JavaScript; diverge and your test follows you:**

- Gating at the lobby via `authHooks`. (Auth that needs per-room DO *state* is a separate, in-object concern — a different pattern, so a different test.)
- Token *placement*: `?token=` on the WS connect (a browser can't set headers on an upgrade), `Authorization: Bearer` on the POST. party-db's client sends them there and `getTokenFromRequest` reads both — the placement is ours, the token value and its verification are yours.
- What `authorize` actually checks (a JWT, a session, a password), and testing with `SELF.fetch` + [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/), one room per test.

party-db rejects unauthorized requests the same way no matter what `authorize`
checks, so the assertions below (`401`, no `webSocket`, `WriteReject`) work for any
gate — no client, no browser. The one thing you'd change: if your token doesn't
ride in `?token=`/`Bearer`, send it however you do in the test. ✅

This assumes a worker that gates both doors, like [recipe 3](./03-external-auth-workos.md)
or [recipe 4](./04-public-read-private-write.md). Swap `TOKEN` for a valid
credential your `authorize` accepts (a signed JWT, a session id) — or hand this file
to your coding agent and let it wire the fixture to your setup.

```ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

// a valid credential your authorize() accepts; a real test mints/signs this
const TOKEN = 's3cret'

// Build a room URL. Token placement is party-db's convention: it rides in ?token=
// on the connect (a browser WS upgrade can't set headers), Bearer on the POST.
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
