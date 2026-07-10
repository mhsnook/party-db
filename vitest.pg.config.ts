import { defineConfig } from 'vitest/config'

// The Postgres lane runs in plain node (like the fast unit suite) but talks to a
// REAL Postgres over TCP — a disposable PG in CI, or a local `docker run` (see the
// README). It's its own config + `pnpm test:pg` so the pure-node unit suite never
// pays for it and contributors without a PG keep getting green runs: every suite
// here `describe.skipIf`s on an unset `PG_URL`.
//
// These are the fast node-side driver checks that answer plan 016's open
// questions (constraint error shape, per-column-kind type round-trips). The
// workerd-side DO→PG connectivity spike lives in the integration suite instead
// (test/integration/pg-connect.test.ts), where a real miniflare worker runs.
export default defineConfig({
  test: {
    include: ['test/pg/**/*.test.ts'],
    environment: 'node',
  },
})
