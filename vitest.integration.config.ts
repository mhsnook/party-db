import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

// The integration suite runs inside workerd (miniflare) so the Durable Object,
// its SQLite, partyserver routing, and the WebSocket path are all real. Kept in
// its own config + `pnpm test:integration` so the fast node unit suite
// (vitest.config.ts) stays pure node and doesn't pay the workerd startup cost.
//
// vitest 4 / pool 0.16 wire the pool as a Vite plugin (`cloudflareTest`) rather
// than the old `defineWorkersConfig` + `poolOptions.workers`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './test/integration/worker.ts',
      miniflare: {
        compatibilityDate: '2025-05-01',
        compatibilityFlags: ['nodejs_compat'],
        // bind the room class to SQLite-backed DO storage (what v1 persists into)
        durableObjects: {
          Main: { className: 'Main', useSQLite: true },
          Guarded: { className: 'Guarded', useSQLite: true },
          Faulty: { className: 'Faulty', useSQLite: true },
          // persists into D1 (env.DB) rather than its own SQLite; still a real DO.
          D1Room: { className: 'D1Room', useSQLite: true },
        },
        // a local D1 database bound as `env.DB` — the target the D1Adapter persists
        // into (data + _oplog both live here). The value is miniflare's database id.
        d1Databases: { DB: 'party-db-d1-test' },
        // The Postgres connection string, forwarded from the CI/local env into the
        // worker so the pg-connectivity spike (plan 015) can reach a real PG over
        // TCP. Unset when no PG is running — that suite skips on the empty string.
        bindings: { PG_URL: process.env.PG_URL ?? '' },
      },
    }),
  ],
  test: {
    include: ['test/integration/**/*.test.ts'],
  },
})
