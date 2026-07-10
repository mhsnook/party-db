// The integration worker's bindings, for the miniflare `env` (typed as
// `Cloudflare.Env`). The D1 fixture (`D1Room`) persists into `env.DB`; the
// semantics spike drives the same binding raw. The DO namespaces are routed by
// partyserver from the URL, so only the D1 binding needs declaring here.

declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    // The Postgres connection string for the pg-connect test. An empty string
    // means "no PG running" — that suite skips.
    PG_URL: string
  }
}
