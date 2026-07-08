# Public read, private write

One `authorize` gates both doors into a room — the socket you open to read
(`kind: 'connect'`) and the POST you send to write (`kind: 'write'`). "Anyone can
watch, only some can edit" is one `if`. This is what the
[RDBMS example](../../example-react-rdbms/) does. ✅

```ts
import { PartyDbServer, definePartyCollection, authHooks, bearer, type AuthContext } from 'party-db/server'
import { routePartykitRequest } from 'partyserver'
import { todoSchema, type Todo } from './schema.ts'

// A shared string keeps the recipe to one moving part. A real app verifies a
// session/JWT (recipe 3) and compares with a constant-time check — and never puts
// the expected credential in a response body.
const PASSWORD = 's3cret'

const authorize = (req: Request, { kind }: AuthContext) => {
  // ✅ reads are open to everyone
  if (kind === 'connect') return true
  // ✅ only writes are password-protected
  return bearer(req) === PASSWORD ? true : { ok: false, status: 401, error: 'a write token is required' }
}

export class Main extends PartyDbServer {
  collections = [definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })]
}

export default {
  fetch: (req: Request, env: unknown) =>
    // authHooks runs authorize at the lobby, before the request reaches the Durable
    // Object — a rejected read never upgrades the socket, a rejected write never wakes the DO.
    routePartykitRequest(
		req,
		env,
		authHooks(authorize)).then((r) => r ?? new Response('not found', { status: 404 })
	),
}
```

Client sends whatever token it holds; reads need none. A rejected write comes back as
a typed `WriteError` you can branch on:

```tsx
const transport = partyTransport({ host: location.host, room: 'board', token: getToken })

tx.isPersisted.promise.catch((e) => {
  if (e instanceof WriteError && e.status === 401) setError('Log in to edit.')
  else setError(e instanceof Error ? e.message : 'Write failed.')
})
```

Variations: gate `'connect'` too so only logged-in people can watch; branch on
`{ party, room }` (also passed to `authorize`) for per-room rules; swap the password
check for a JWT — that's [recipe 3](./03-external-auth-workos.md).
