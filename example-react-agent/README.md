# party-db + Cloudflare Agents SDK example

A task board where humans and an agent write into the same TanStack DB collections.
You add a `tasks` row from the browser. The agent in the room picks it up, works it
as a durable fiber, and writes its `notes` rows and the task's status back through
party-db, so every open tab sees each step land as it commits.

The server is a Cloudflare Agents SDK [`Agent`](https://developers.cloudflare.com/agents/)
that holds a `PartyDbCore` ([architecture §15](../docs/architecture.md)). The agent's
own state (`setState` → `useAgent`) rides the SDK's socket; the collections ride
party-db's. One Durable Object, two protocols, no shared frames.

## How to run this example app

From the root of this repo:

```bash
pnpm install
cd example-react-agent
pnpm install
pnpm dev        # wrangler dev (:8787) + vite (:5173), proxied to one origin
```

Open <http://localhost:5173> in two tabs. Add a task in one and watch the agent's
notes appear in both. Kill `wrangler dev` while a task is `working`, start it
again, and the fiber resumes where its last `stash` left off.

The agent is deterministic: three fixed notes with a short delay between them, so
the example runs with no model key. The place to call a model is the loop in
`triage()` in `src/server.ts`.

## What the agents package does to the composed-host pattern

The README's "A Server that can't subclass holds the core instead" pattern works
unchanged on `agents` 0.30. Three things about the package shape how you apply it:

- **`Agent` extends `DurableObject`, not partyserver's `Server`.** It still has
  `onConnect`, `onMessage`, `onRequest`, `getConnectionTags` and
  `getConnections(tag)` with the same signatures, so the forwarding is identical.
  `routeAgentRequest(req, env, { prefix: 'parties' })` serves party-db's
  `/parties/board/<room>` path, and the default prefix serves `useAgent`.
- **`onFiberRecovered` runs before `onStart`.** The SDK recovers interrupted
  fibers on wake, then calls `onStart`. A recovered fiber that commits rows needs
  the core already built, so this example builds it in the constructor and keeps
  the `init()` promise as `ready`. `onStart` returns `ready`, so every socket and
  request still waits for it.
- **`shouldSendProtocolMessages` keeps party-db sockets clean.** The SDK sends
  identity, state and MCP frames to every socket on connect and on every
  `setState`. Returning `false` for a party-db connect stops all of them, so the
  party-db client never has to drop a stray frame.

Two things to know before you lean on it:

- **A current `compatibility_date`.** A fiber or schedule left in storage wakes the
  Durable Object from an alarm on the next deploy. On an old compatibility date that
  wake has no `ctx.id.name`, and the SDK throws on every request to that instance.
  This example uses `2026-10-01`.
- **The agent watches writes through the core's `broadcast` callback.** party-db
  has no post-commit hook, so `observe()` parses the frame the core hands it to
  fan out. The agent is one more subscriber to the room, which is honest, and it is
  also the seam a future `onCommit` option would replace.

## Files

| File | Role |
| --- | --- |
| `src/schema.ts` | the two collections and the agent's state type, imported by both halves |
| `src/server.ts` | the `Board` agent: builds the core, forwards the three seams, runs the triage fiber |
| `src/App.tsx` | party-db collections via `useLiveQuery`, agent state via `useAgent` |
| `src/main.tsx` | React entry point |
| `vite.config.ts` | proxies `/parties` and `/agents` to the worker |
| `wrangler.jsonc` | one `Board` Durable Object with SQLite, on a current compatibility date |
