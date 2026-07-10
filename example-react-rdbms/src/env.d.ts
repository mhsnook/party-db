// The worker's bindings. `env.DB` is the D1 database this room persists into (the
// `todos` table *and* party-db's `_oplog` both live there). It's OPTIONAL on
// purpose: present → the room uses D1; absent → the DO's own embedded SQLite. That
// presence is the whole persistence switch (see server.ts). Bound in wrangler.jsonc.
declare namespace Cloudflare {
  interface Env {
    DB?: D1Database
  }
}
