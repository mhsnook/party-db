// Minimal ambient types for the bits of node:sqlite the test engine uses. The
// client tsconfig runs with `types: []` (no @types/node), so we declare just the
// surface we touch rather than pull in all of Node's types.
declare module 'node:sqlite' {
  export class StatementSync {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }
  export class DatabaseSync {
    constructor(path: string)
    prepare(sql: string): StatementSync
    exec(sql: string): void
    close(): void
  }
}
