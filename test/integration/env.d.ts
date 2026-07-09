// The integration worker's bindings, for the miniflare `env` (typed as
// `Cloudflare.Env`). The D1 fixture (`D1Room`) persists into `env.DB`; the
// semantics spike drives the same binding raw. The DO namespaces are routed by
// partyserver from the URL, so only the D1 binding needs declaring here.

declare namespace Cloudflare {
  interface Env {
    DB: D1Database
  }
}
