// An integer owner column on real Postgres. SQLite converts a bound '1' into an
// INTEGER by column affinity; Postgres has no affinity, it infers the parameter's
// type from the target column instead. Both paths have to end with the stamped
// uid stored as a real integer and the row readable by its owner, so this is the
// half the node lane (test/access-core.test.ts) cannot prove.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { z } from 'zod'
import { PgAdapter, type PgClient } from '../../src/server/pg-adapter.ts'
import { PartyDbCore } from '../../src/server/core.ts'
import { audienceTag, viewerFromTags, viewerTags } from '../../src/server/access.ts'
import { bearer } from '../../src/server/auth.ts'
import { definePartyCollection } from '../../src/schema.ts'
import type { SequencedBatch, WriteAck, WriteBatch, WriteReject } from '../../src/protocol.ts'
import type { WriteIdentity } from '../../src/server/persistence.ts'

const PG_URL = process.env.PG_URL

// user_id is a plain integer FK, the shape a SERIAL users table gives you.
const cards = definePartyCollection({
  name: 'cards',
  key: 'id',
  schema: z.object({ id: z.string(), user_id: z.number().optional(), status: z.string() }),
  ownerColumn: 'user_id',
})
const DDL = `CREATE TABLE cards (id text PRIMARY KEY, user_id integer NOT NULL, status text NOT NULL)`

const auth = (req: Request): WriteIdentity | null => {
  const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
  return token ? { claims: { sub: token } } : null
}

describe.skipIf(!PG_URL)('an integer owner column (real Postgres)', () => {
  let client: pg.Client
  const pgc: PgClient = { query: (text, values) => client.query(text, values) as any }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client?.query('DROP TABLE IF EXISTS cards, _oplog')
    await client?.end()
  })

  async function room() {
    await client.query('DROP TABLE IF EXISTS cards, _oplog')
    await client.query(DDL)
    const sockets: { tags: string[]; frames: SequencedBatch[] }[] = []
    const core = new PartyDbCore({
      collections: [cards],
      adapter: new PgAdapter(() => Promise.resolve(pgc), [cards]),
      broadcast: (m, audience) => {
        const to = audience === 'all' ? sockets : sockets.filter((s) => s.tags.includes(audienceTag(audience)))
        to.forEach((s) => s.frames.push(JSON.parse(m)))
      },
      auth: () => auth,
    })
    await core.init()
    const connect = async (token: string) => {
      const url = `https://e.com/parties/main/r?token=${token}`
      const socket = { tags: viewerTags(await core.resolveViewer(new Request(url))), frames: [] as SequencedBatch[] }
      await core.connect((m) => socket.frames.push(JSON.parse(m)), url, viewerFromTags(socket.tags))
      sockets.push(socket)
      return socket
    }
    const post = async (body: WriteBatch[], token: string) => {
      const res = await core.handleWrite(
        new Request('https://e.com/parties/main/r', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
      )
      return { status: res.status, body: (await res.json()) as WriteAck & WriteReject }
    }
    return { core, connect, post }
  }

  const insert = (id: string, extra: Record<string, unknown> = {}): WriteBatch[] => [
    { channel: 'cards', ops: [{ type: 'insert', value: { id, status: 'learning', ...extra } }] },
  ]
  const types = (s: { frames: SequencedBatch[] }) => s.frames.filter((f) => !f.reset).flatMap((f) => f.ops.map((o) => o.type))

  it('stamps the string sub claim into the integer column, and it lands as an integer', async () => {
    const { post } = await room()
    expect((await post(insert('c1'), '1')).status).toBe(200)
    const { rows } = await client.query(`SELECT user_id, pg_typeof(user_id)::text AS t FROM cards WHERE id = 'c1'`)
    expect(rows[0]).toEqual({ user_id: 1, t: 'integer' })
  })

  it('reads the row back to its owner and to nobody else', async () => {
    const { post, connect } = await room()
    await post(insert('c1'), '1')
    await post(insert('c2'), '2')
    const [one, two] = [await connect('1'), await connect('2')]
    const ids = (s: { frames: SequencedBatch[] }) => s.frames.flatMap((f) => f.ops.map((o) => (o.value as { id: string }).id))
    expect(ids(one)).toEqual(['c1'])
    expect(ids(two)).toEqual(['c2'])
  })

  it('fans a write out to the owner only, matching the integer against the tag', async () => {
    const { post, connect } = await room()
    const [one, two] = [await connect('1'), await connect('2')]
    await post(insert('c1'), '1')
    expect(types(one)).toEqual(['insert'])
    expect(types(two)).toEqual([])
  })

  // The forged-owner refusal is decided in `gateOp` from the payload and the claim,
  // with no driver involved, so it belongs in the node lane. What needs a real
  // database is the stored-row check: the owner it compares came back through
  // `readRows` as a JS number.
  it('checks an update against the stored integer owner', async () => {
    const { post } = await room()
    await post(insert('c1'), '1')
    const edit = [{ channel: 'cards', ops: [{ type: 'update' as const, value: { id: 'c1', status: 'known' } }] }]
    expect((await post(edit, '2')).status).toBe(403)
    expect((await post(edit, '1')).status).toBe(200)
  })

  it('hands a row to a new integer owner and withdraws it from the old one', async () => {
    const { core, post, connect } = await room()
    await post(insert('c1'), '1')
    const [one, two] = [await connect('1'), await connect('2')]
    await core.commit([{ channel: 'cards', ops: [{ type: 'update', value: { id: 'c1', user_id: 2 } }] }])
    expect(types(one)).toEqual(['delete'])
    expect(types(two)).toEqual(['insert'])
  })
})
