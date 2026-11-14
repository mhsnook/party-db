// A slice snapshot on D1 (docs/architecture.md §18), driven on the adapter over the
// bound `env.DB`: `WHERE "<sliceBy>" = ?` against an integer column, so a slice
// value matches whether it arrives as 7 or "7".

import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { z } from 'zod'
import { D1Adapter } from '../../src/server/d1-adapter.ts'
import { definePartyCollection } from '../../src/schema.ts'

const comments = definePartyCollection({
  name: 'comments',
  key: 'id',
  schema: z.object({ id: z.string(), thread_id: z.number(), body: z.string() }),
  sliceBy: 'thread_id',
})
const todos = definePartyCollection({ name: 'todos', key: 'id', schema: z.object({ id: z.string(), text: z.string() }) })

beforeEach(async () => {
  await env.DB.exec(`DROP TABLE IF EXISTS comments`)
  await env.DB.exec(`DROP TABLE IF EXISTS todos`)
  await env.DB.exec(`DROP TABLE IF EXISTS _oplog`)
  await env.DB.exec(`CREATE TABLE comments (id TEXT PRIMARY KEY, thread_id INTEGER NOT NULL, body TEXT NOT NULL)`)
  await env.DB.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL)`)
})

async function adapter() {
  const a = new D1Adapter(env.DB, [comments, todos])
  await a.init()
  await a.write([
    {
      channel: 'comments',
      ops: [
        { type: 'insert', value: { id: 'a', thread_id: 7, body: 'seven' } },
        { type: 'insert', value: { id: 'b', thread_id: 8, body: 'eight' } },
      ],
    },
  ])
  return a
}

describe('D1Adapter slice snapshots', () => {
  it('reads one slice, whether its value arrives as a number or as text', async () => {
    const a = await adapter()
    for (const slice of [7, '7']) {
      const [batch] = await a.snapshot('comments', slice)
      expect(batch).toMatchObject({ channel: 'comments', reset: true, ready: true, slice })
      expect(batch!.ops.map((op) => op.value.id)).toEqual(['a'])
    }
  })

  it('leaves the sliced table out of the connect-time snapshot', async () => {
    const a = await adapter()
    expect((await a.snapshot()).map((b) => b.channel)).toEqual(['todos'])
  })
})
