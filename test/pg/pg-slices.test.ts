// A slice snapshot on Postgres (docs/architecture.md §18): `WHERE "<sliceBy>" = $1`
// against the app's own table, with an integer slice column, so a client's
// slice value matches whether it arrives as 7 or "7".

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { z } from 'zod'
import { PgAdapter, type PgClient } from '../../src/server/pg-adapter.ts'
import { definePartyCollection } from '../../src/schema.ts'

const PG_URL = process.env.PG_URL

const comments = definePartyCollection({
  name: 'comments',
  key: 'id',
  schema: z.object({ id: z.string(), thread_id: z.number(), body: z.string() }),
  sliceBy: 'thread_id',
})
const todos = definePartyCollection({ name: 'todos', key: 'id', schema: z.object({ id: z.string(), text: z.string() }) })

describe.skipIf(!PG_URL)('PgAdapter slice snapshots (real Postgres)', () => {
  let client: pg.Client
  const pgc: PgClient = { query: (text, values) => client.query(text, values) as any }
  let adapter: PgAdapter

  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
    await client.query('DROP TABLE IF EXISTS comments, todos, _oplog')
    await client.query(`CREATE TABLE comments (id text PRIMARY KEY, thread_id integer NOT NULL, body text NOT NULL)`)
    await client.query(`CREATE TABLE todos (id text PRIMARY KEY, text text NOT NULL)`)
    adapter = new PgAdapter(() => Promise.resolve(pgc), [comments, todos])
    await adapter.init()
    await adapter.write([
      {
        channel: 'comments',
        ops: [
          { type: 'insert', value: { id: 'a', thread_id: 7, body: 'seven' } },
          { type: 'insert', value: { id: 'b', thread_id: 8, body: 'eight' } },
        ],
      },
    ])
  })
  afterAll(async () => {
    await client?.query('DROP TABLE IF EXISTS comments, todos, _oplog')
    await client?.end()
  })

  it('reads one slice, whether its value arrives as a number or as text', async () => {
    for (const slice of [7, '7']) {
      const [batch] = await adapter.snapshot('comments', slice)
      expect(batch).toMatchObject({ channel: 'comments', reset: true, ready: true })
      expect(batch!.ops.map((op) => op.value.id)).toEqual(['a'])
    }
  })

  it('reads the whole table for a whole-channel subscribe', async () => {
    const [batch] = await adapter.snapshot('comments')
    expect(batch!.ops.map((op) => op.value.id).sort()).toEqual(['a', 'b'])
    expect(batch).not.toHaveProperty('slice')
  })

  it('leaves the sliced table out of the connect-time snapshot', async () => {
    expect((await adapter.snapshot()).map((b) => b.channel)).toEqual(['todos'])
  })

  it('replays one channel when asked, and every channel but the sliced ones when not', async () => {
    await adapter.write([{ channel: 'todos', ops: [{ type: 'insert', value: { id: 't1', text: 'x' } }] }])
    expect((await adapter.replaySince(0, 'comments'))!.map((b) => b.channel)).toEqual(['comments'])
    expect((await adapter.replaySince(0))!.map((b) => b.channel)).toEqual(['todos'])
  })
})
