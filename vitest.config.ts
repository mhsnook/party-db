import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // the integration suite runs in the workers pool, not node — see
    // vitest.integration.config.ts / `pnpm test:integration`.
    exclude: ['test/integration/**', 'node_modules/**'],
    environment: 'node',
  },
})
