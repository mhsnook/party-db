import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // pure-logic unit tests for the client engine + wire helpers. The
    // server/integration suites (miniflare workers pool) land with the
    // structured-tables work — see docs/sqlite-do-todo.md item 2.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
