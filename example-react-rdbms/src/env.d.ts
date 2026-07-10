// The worker's bindings. `env.DB` is the D1 database the room persists into; if no
// D1 binding is present, the example app runs using the DO's native SQLite.
declare namespace Cloudflare {
  interface Env {
    DB?: D1Database
  }
}
