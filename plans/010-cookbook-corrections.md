# Plan 010: Correct the auth cookbooks (secret echo, WorkOS env scope)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- docs/cookbooks example-react-rdbms/src/server.ts docs/architecture.md`
> Compare the excerpts below against the live files before editing.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (docs + one example file)
- **Depends on**: none
- **Category**: security / docs
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

Cookbooks are templates people clone into production. Two problems:

1. **Recipes 3–4 and the rdbms example echo the expected secret in the 401 body**
   (`error: \`enter "${PASSWORD}" to write\``) and compare secrets with `===`.
   In the demo the password is deliberately public (printed on the page), but the
   *pattern* — expected credential in an error response, non-constant-time
   compare — is exactly what a copy-paste carries into a real deployment.
2. **The WorkOS recipe doesn't run as written**: it constructs
   `new WorkOS(env.WORKOS_API_KEY)` at module scope, where a Workers `env` binding
   does not exist (bindings are only available inside handlers). The one recipe
   demonstrating production-grade token verification fails at import time.

House style (from the maintainer): every cookbook must be **correct**, but
boilerplate repetition across cookbooks is a non-goal — eliding shared setup with
`// ... same setup as recipe 01` is preferred. The library is the main character.

## Current state

- `docs/cookbooks/04-public-read-private-write.md:13-20`:

  ```ts
  const PASSWORD = 's3cret' // a real app checks a session/JWT here

  const authorize = (req: Request, { kind }: AuthContext) => {
    // ✅ reads are open to everyone
    if (kind === 'connect') return true
    // ✅ only writes are password-protected
    return bearer(req) === PASSWORD ? true : { ok: false, status: 401, error: `enter "${PASSWORD}" to write` }
  }
  ```

- `example-react-rdbms/src/server.ts:6-8, 31-34` — same pattern; the file comment
  says the password "is printed on the page on purpose" (the demo intent stays):

  ```ts
  const PASSWORD = 's3cret'
  …
  const authorize = (req: Request, { kind }: AuthContext) => {
    if (kind === 'connect') return true // reads are open to everyone
    return bearer(req) === PASSWORD ? true : { ok: false, status: 401, error: `enter "${PASSWORD}" to write` }
  }
  ```

  Before changing the error text, check `example-react-rdbms/src/App.tsx` for any
  UI logic that displays or matches on that error string (the unlock prompt) — the
  page prints the password itself, so the error no longer needs to.

- `docs/cookbooks/03-external-auth-workos.md:9-24` — the module-scope `env` bug:

  ```ts
  import { WorkOS } from '@workos-inc/node'
  …
  const workos = new WorkOS(env.WORKOS_API_KEY)
  const JWKS = createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(env.WORKOS_CLIENT_ID)))

  const authorize: Authorize = async (req, { room }) => { … jwtVerify(token, JWKS) … }

  export default {
    fetch: (req: Request, env: unknown) =>
      routePartykitRequest(req, env as never, authHooks(authorize)).then(…),
  }
  ```

- `docs/architecture.md:226-251` (§10) carries a sibling WorkOS snippet that
  side-steps the bug differently (a free `jwksUrl` variable, no `env` at module
  scope) — after fixing the cookbook, give §10 the same lazy-init shape *only if*
  its snippet would otherwise contradict the cookbook; a one-line
  `const jwksUrl = …` sketch is acceptable there since it's a decision record, not
  a recipe.

- The lazy-init pattern that fixes recipe 03 (bindings first available in `fetch`,
  jose's JWKS cache preserved because the closure is reused across requests):

  ```ts
  let authorize: Authorize | undefined

  const makeAuthorize = (env: Env): Authorize => {
    const workos = new WorkOS(env.WORKOS_API_KEY)
    const JWKS = createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(env.WORKOS_CLIENT_ID)))
    return async (req, { room }) => { /* unchanged verification body */ }
  }

  export default {
    fetch: (req: Request, env: Env) =>
      routePartykitRequest(req, env as never, authHooks((authorize ??= makeAuthorize(env)))).then(
        (r) => r ?? new Response('not found', { status: 404 }),
      ),
  }
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Secret-echo guard | `grep -rn '\${PASSWORD}' docs/cookbooks example-react-rdbms` | no matches after fix |
| Module-scope env guard | `grep -n 'new WorkOS(env' docs/cookbooks/03-external-auth-workos.md` | only inside a function after fix |
| Example still typechecks | `cd example-react-rdbms && pnpm typecheck` | exit 0 (check the example's package.json for the exact script name first) |

## Scope

**In scope**:
- `docs/cookbooks/03-external-auth-workos.md`
- `docs/cookbooks/04-public-read-private-write.md`
- `example-react-rdbms/src/server.ts` (error-message line only)
- `example-react-rdbms/src/App.tsx` (only if it matches on the old error string)
- `docs/architecture.md` §10 snippet (only the minimal alignment described above)

**Out of scope**:
- `docs/cookbooks/01-atomic-writes.md`, `02-server-validation.md` — verified
  correct during the audit; don't touch.
- `src/**` — no library changes.
- Restructuring cookbooks, deduplicating their boilerplate, or changing the demo's
  printed-password design (it's intentional).

## Git workflow

- Branch: `advisor/010-cookbook-corrections`
- Commit style: `docs(cookbooks): don't echo the secret; fix WorkOS env scope`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Remove the secret from the 401 bodies

In recipe 04 and `example-react-rdbms/src/server.ts`, change the reject to a
generic message, e.g. `{ ok: false, status: 401, error: 'a write token is required' }`,
and add one comment line where `PASSWORD` is declared, in the recipe's existing
voice, noting: real apps verify a session/JWT (point at recipe 03) and compare
secrets with a constant-time comparison — never put the expected credential in a
response. Check App.tsx per "Current state"; update its prompt copy only if it
referenced the old message.

**Verify**: the secret-echo grep → no matches; the example app still typechecks
(command above; if the example has no typecheck script, `pnpm --dir example-react-rdbms exec tsc -p tsconfig.json --noEmit` — inspect its tsconfig layout first).

### Step 2: Fix recipe 03's env scope

Apply the lazy-init shape from "Current state" to the recipe's code block
(keeping the verification body verbatim), and add one explanatory line in the
recipe prose: bindings exist only inside handlers, so the client is built on
first request and reused (jose keeps caching the JWKS). Keep the recipe elided
per house style — if the fix makes the block feel long, compress non-auth lines
with `// ... same setup as recipe 04`.

**Verify**: module-scope grep → `new WorkOS(env` appears only inside
`makeAuthorize`; read the block once end-to-end as if typing it into a fresh
Worker — every identifier is imported or defined.

### Step 3: Align architecture §10 if needed

Read `docs/architecture.md:226-251`. If its snippet now contradicts the cookbook
(module-scope `env` or the secret-echo pattern), apply the minimal same-shape fix;
if it's merely *elliptical* (the free `jwksUrl`), leave it, optionally adding
`// from env, resolved in fetch — see cookbook 03`.

**Verify**: `grep -n "WORKOS_API_KEY" docs/architecture.md` shows no module-scope
constructor pattern.

## Test plan

Docs + example only. Gates: the two greps, the example's typecheck, and a full
read-through of each modified code block for self-containedness.

## Done criteria

- [ ] No `${PASSWORD}` (or the literal password) in any error message in cookbooks or example server
- [ ] Recipe 04 + example note the constant-time-compare / real-auth caveat in one line each
- [ ] Recipe 03 builds its WorkOS client lazily inside the handler path; prose explains why
- [ ] `docs/architecture.md` §10 does not contradict the fixed recipe
- [ ] Example app typechecks; only in-scope files modified; `plans/README.md` updated

## STOP conditions

- `App.tsx` turns out to *parse* the 401 error string for its unlock flow (not
  just display it) — changing the message would break the demo; report the
  coupling and propose the message it should match on instead.
- The cookbook files have been restructured since planning (drift).

## Maintenance notes

- Recipe 02 documents proposed-but-unbuilt `writeSchema` behavior behind 🚧
  markers — plan 013 (validation design) will touch it; don't pre-empt here.
- Reviewer: confirm the recipes still read as *recipes* — short, library-centric,
  elided boilerplate — not as hardened production guides; one caveat line each is
  the agreed depth.
