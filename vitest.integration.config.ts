import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

// The integration suite runs inside workerd (miniflare) so the Durable Object,
// its SQLite, partyserver routing, and the WebSocket path are all real. Kept in
// its own config + `pnpm test:integration` so the fast node unit suite
// (vitest.config.ts) stays pure node and doesn't pay the workerd startup cost.
export default defineWorkersConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    poolOptions: {
      workers: {
        main: './test/integration/worker.ts',
        // each test already uses a distinct room (→ distinct DO), so we don't need
        // per-test storage rollback — and isolated storage trips over SQLite's
        // -wal/-shm sidecars (a known pool issue).
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: '2025-05-01',
          compatibilityFlags: ['nodejs_compat'],
          // bind the room class to SQLite-backed DO storage (what v1 persists into)
          durableObjects: {
            Main: { className: 'Main', useSQLite: true },
          },
        },
      },
    },
  },
})
