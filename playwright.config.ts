import { defineConfig } from '@playwright/test'

// Runs one example app's own browser tests (`<example>/e2e/`) against that app,
// built from this checkout's `src/`. Every example serves its worker on :8787 and
// its Vite site on :5173, so one runs at a time: `EXAMPLE=example-react pnpm test:e2e`.
const example = process.env.EXAMPLE
if (!example) throw new Error('Set EXAMPLE to an example directory, e.g. EXAMPLE=example-react pnpm test:e2e')

export default defineConfig({
  testDir: `${example}/e2e`,
  // the tabs in one test share a room, and the tests in one file share a worker
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'off' },
  // Each example binds both servers to 127.0.0.1 in its own config (vite.config.ts,
  // wrangler.jsonc), so this runs the app exactly as `pnpm dev` does.
  webServer: [
    { command: 'pnpm dev:worker', cwd: example, port: 8787, stdout: 'pipe', reuseExistingServer: !process.env.CI, timeout: 60_000 },
    { command: 'pnpm dev:client', cwd: example, url: 'http://127.0.0.1:5173', stdout: 'pipe', reuseExistingServer: !process.env.CI, timeout: 60_000 },
  ],
})
