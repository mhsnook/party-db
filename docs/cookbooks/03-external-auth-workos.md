# Integrate with existing auth provider (WorkOS example)

The example here uses all the same boilerplate as the other docs, but with one extra
moving part: the 10 lines in the middle that define an `authorize` function to validate
the JWT and compare it to the request – in this case, ensuring that the room ID matches
the WorkOS org ID, so the board is shared to only that org's members. ✅

```ts
import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, definePartyCollection, authHooks, bearer, type Authorize } from 'party-db/server'
import { jwtVerify, createRemoteJWKSet } from 'jose'
import { WorkOS } from '@workos-inc/node'
import { cardSchema } from './schema.ts'

export class Main extends PartyDbServer {
  collections = [definePartyCollection({ name: 'cards', key: 'id', schema: cardSchema })]
}

// WorkOS AuthKit hands users a signed JWT. We verify it against WorkOS's public keys
// and jose caches them so there's no network round-trip per request.
const workos = new WorkOS(env.WORKOS_API_KEY)
const JWKS = createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(env.WORKOS_CLIENT_ID)))

const authorize: Authorize = async (req, { room }) => {
  const token = bearer(req) ?? new URL(req.url).searchParams.get('token') // header on writes, ?token= on connect
  if (!token) return { ok: false, status: 401 }
  try {
    const { payload } = await jwtVerify(token, JWKS)
    return payload.org_id === room ? true : { ok: false, status: 403, error: 'not your board' }
  } catch {
    return { ok: false, status: 401 } // bad or expired token
  }
}

export default {
  fetch: (req: Request, env: unknown) =>
    routePartykitRequest(req, env as never, authHooks(authorize)).then((r) => r ?? new Response('not found', { status: 404 })),
}
```

Client sends its WorkOS token when connecting; that's the only auth-aware line:

```ts
const transport = partyTransport({
  host: location.host,
  room: myOrgId, // the same org id the server checks
  token: getAccessToken, // a function is re-read each reconnect, so refreshes just work
})
```

WorkOS owns identity and membership; party-db just checks the claim at the door.
Swapping in Clerk, Auth0, or your own JWT is the same three lines with a different
`jwtVerify`.

> WorkOS SDK method names (e.g. `getJwksUrl`) shift between versions — check their
> current AuthKit docs. The shape (verify a signed token, read a claim) is what
> matters.
