// How much does the async PersistenceAdapter contract cost per write, given our
// embedded deployment is synchronous DO-SQLite?
//
// The adapter's `write` is async in SIGNATURE only — its body runs the SQLite
// transaction synchronously (ctx.storage.transactionSync), with no real await
// inside. So the async contract buys D1-readiness (an async target whose commit
// is `batch()`); the question is what that costs the sync deployment.
//
// Three cases over the SAME real node:sqlite adapter:
//   (1) queued + await  — the production path (PartyDbServer.serialize + await)
//   (2) await only       — await the write, but no serialize queue
//   (3) raw sync         — write() runs fully on call (no real await inside), so
//                          don't await; this is the sync-deployment floor.
// Overhead = (1) - (3); the serialize queue's own cost = (1) - (2).

import { z } from 'zod'
import { SqliteAdapter } from '../../src/server/sqlite-adapter.ts'
import { definePartyCollection } from '../../src/schema.ts'
import { memoryEngine } from '../helpers/sql-engine.ts'
import { report, delta } from './_harness.ts'

const todoSchema = z.object({ id: z.string(), text: z.string(), done: z.boolean() })
const collections = [definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema })]

function freshAdapter() {
  const { engine, db } = memoryEngine()
  db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`)
  const adapter = new SqliteAdapter(engine, collections)
  adapter.init()
  return adapter
}

const body = (i: number) => [{ channel: 'todos', ops: [{ type: 'insert' as const, value: { id: 'k' + i, text: 't', done: false } }] }]

// the exact serialize() from PartyDbServer — chains each write behind the prior.
function makeSerializer() {
  let queue: Promise<unknown> = Promise.resolve()
  return function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
}

export default async function run() {
  const results = await report('async-overhead — PersistenceAdapter contract cost on the sync (DO-SQLite) deployment', {
    iterations: 20_000,
    reps: 5,
    cases: [
      {
        name: 'queued + await (production)',
        mode: 'async',
        setup: () => ({ adapter: freshAdapter(), serialize: makeSerializer() }),
        run: ({ adapter, serialize }, i) => serialize(() => adapter.write(body(i))),
      },
      {
        name: 'await only (no queue)',
        mode: 'async',
        setup: () => ({ adapter: freshAdapter() }),
        run: ({ adapter }, i) => adapter.write(body(i)),
      },
      {
        name: 'raw sync (floor)',
        mode: 'sync',
        setup: () => ({ adapter: freshAdapter() }),
        // write() does all its work synchronously and returns an already-resolved
        // promise; not awaiting it models a synchronous deployment.
        run: ({ adapter }, i) => void adapter.write(body(i)),
      },
    ],
  })

  console.log(`\n  async-contract overhead  = ${delta(results['queued + await (production)'], results['raw sync (floor)'])}`)
  console.log(`  serialize queue's own cost = ${delta(results['queued + await (production)'], results['await only (no queue)'])}`)
  console.log()
}
