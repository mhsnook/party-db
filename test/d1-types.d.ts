// Minimal ambient D1 surface for the node unit typecheck. The unit config
// (tsconfig.client.json) runs with `types: []`, so @cloudflare/workers-types isn't
// loaded — yet the D1 adapter's unit test imports src/server/d1-adapter.ts, which
// names the global `D1Database`. We declare just the slice the adapter + the
// node:sqlite fake touch (same approach as node-sqlite.d.ts). The REAL D1 types
// cover src/server under tsconfig.server.json / tsconfig.integration.json; this
// file is not in those programs, so there's no duplicate-declaration clash.

interface D1Result<T = Record<string, unknown>> {
  success: boolean
  results: T[]
  meta: Record<string, unknown>
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>
}
interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<{ count: number; duration: number }>
}
