// The worker's bindings. `env.DB` is the D1 database this room persists into — the
// `todos` table *and* party-db's `_oplog` both live there. Declared here so
// `this.env.DB` types in server.ts; bound in wrangler.jsonc.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
  }
}
