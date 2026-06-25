import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Client on :5173, Worker on :8787. Proxy /parties/* (HTTP + WS) to the worker
// so the browser talks to a single origin — no CORS, and partysocket's ws
// upgrade is forwarded too.
export default defineConfig({
  plugins: [react()],
  // This example imports party-db from ../../src, which pulls its own copy of
  // @tanstack/db from the repo root. dedupe forces ONE copy into the bundle so
  // the collection party-db creates is `instanceof` the same CollectionImpl
  // that useLiveQuery checks against — without this, from() throws at runtime.
  resolve: {
    dedupe: ['@tanstack/db'],
  },
  server: {
    proxy: {
      '/parties': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: true },
    },
  },
})
