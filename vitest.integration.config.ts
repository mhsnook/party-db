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
        },
      },
    }),
  ],
  test: {
    include: ['test/integration/**/*.test.ts'],
  },
})
