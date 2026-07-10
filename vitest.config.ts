import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // the integration suite runs in the workers pool, not node — see
    // vitest.integration.config.ts / `pnpm test:integration`. the pg lane needs a
    // real Postgres and runs on its own (`pnpm test:pg`, vitest.pg.config.ts) so
    // this fast unit suite stays pure node with no external service.
    exclude: ['test/integration/**', 'test/pg/**', 'node_modules/**'],
    environment: 'node',
  },
})
