import { defineConfig } from 'vite'

// Client on :5173, Worker on :8787. Proxy /parties/* (HTTP + WS) to the worker
// so the browser talks to a single origin — no CORS, and partysocket's ws
// upgrade is forwarded too.
export default defineConfig({
  server: {
    // IPv4 on purpose, like the worker (wrangler.jsonc `dev.ip`): left to `localhost`,
    // a machine that resolves it to ::1 binds IPv6 only, and the proxy below misses.
    host: '127.0.0.1',
    proxy: {
      '/parties': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: true },
    },
  },
})
