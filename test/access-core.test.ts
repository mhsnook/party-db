// Cookbook 5's access policies at the core's four choke points — the write gate,
// the snapshot, the `?since` backlog, and the fan-out — driven through a composed
// host over a real in-memory SQLite. Three users hold "sockets" (arrays of the
// frames they receive): alice, bob, and an anonymous visitor.

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { PartyDbCore } from '../src/server/core.ts'
import { SqliteAdapter } from '../src/server/sqlite-adapter.ts'
import { audienceTag, viewerFromTags, viewerTags, type Viewer } from '../src/server/access.ts'
import { bearer } from '../src/server/auth.ts'
import { definePartyCollection, type PartyCollection } from '../src/schema.ts'
import type { PersistenceAdapter, WriteIdentity } from '../src/server/persistence.ts'
import type { SequencedBatch, WriteAck, WriteBatch, WriteReject } from '../src/protocol.ts'
import { memoryEngine } from './helpers/sql-engine.ts'

const phraseSchema = z.object({ id: z.string(), text: z.string() })
const cardSchema = z.object({ id: z.string(), user_id: z.string().optional(), status: z.string() })

// the polyglot shape: a public catalog any member adds to, and per-user cards.
const phrases = definePartyCollection({ name: 'phrases', key: 'id', schema: phraseSchema, access: { read: 'public', insert: 'authed' } })
const cards = definePartyCollection({ name: 'cards', key: 'id', schema: cardSchema, ownerColumn: 'user_id' })
const collections = [phrases, cards]

// the test's Bearer token IS the uid (a real app verifies a JWT and reads `sub`).
const auth = (req: Request): WriteIdentity | null => {
  const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
  return token ? { claims: { sub: token } } : null
}

type Socket = { tags: string[]; frames: SequencedBatch[] }

async function room(opts: { collections?: PartyCollection<any>[]; adapter?: (a: SqliteAdapter) => PersistenceAdapter } = {}) {
  const { engine, db } = memoryEngine()
  db.exec(`CREATE TABLE phrases (id TEXT PRIMARY KEY, text TEXT NOT NULL)`)
  db.exec(`CREATE TABLE cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL)`)
  const cols = opts.collections ?? collections
  const sqlite = new SqliteAdapter(engine, cols)
  const sockets: Socket[] = []
  const core = new PartyDbCore({
    collections: cols,
    adapter: opts.adapter ? opts.adapter(sqlite) : sqlite,
    broadcast: (m) => sockets.forEach((s) => s.frames.push(JSON.parse(m))),
    broadcastTo: (m, audience) => sockets.filter((s) => s.tags.includes(audienceTag(audience))).forEach((s) => s.frames.push(JSON.parse(m))),
    auth: () => auth,
  })
  await core.init()

  // a socket connects the way PartyDbServer wires it: resolve, pin as tags, connect.
  const connect = async (token?: string, since?: number) => {
    const url = `https://example.com/parties/main/room?${new URLSearchParams({ ...(token ? { token } : {}), ...(since !== undefined ? { since: String(since) } : {}) })}`
    const viewer = await core.resolveViewer(new Request(url))
    const socket: Socket = { tags: viewerTags(viewer), frames: [] }
    await core.connect((m) => socket.frames.push(JSON.parse(m)), url, viewerFromTags(socket.tags))
    sockets.push(socket)
    return socket
  }
  const post = async (body: WriteBatch[], token?: string) => {
    const res = await core.handleWrite(
      new Request('https://example.com/parties/main/room', {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify(body),
      }),
    )
    return { status: res.status, body: (await res.json()) as WriteAck & WriteReject }
  }
  return { core, db, connect, post }
}

const card = (id: string, status = 'learning', extra: Record<string, unknown> = {}): WriteBatch[] => [
  { channel: 'cards', ops: [{ type: 'insert', value: { id, status, ...extra } }] },
]
const ids = (frames: SequencedBatch[], channel: string) =>
  frames.filter((f) => f.channel === channel).flatMap((f) => f.ops.map((op) => (op.value as { id: string }).id))

describe('access — the write gate', () => {
  it("stamps the writer's uid on an owner insert", async () => {
    const { post, db } = await room()
    expect((await post(card('c1'), 'alice')).status).toBe(200)
    expect(db.prepare(`SELECT user_id FROM cards WHERE id = 'c1'`).get()).toEqual({ user_id: 'alice' })
  })

  it('refuses an anonymous owner insert 401 and a forged owner 403', async () => {
    const { post, db } = await room()
    expect((await post(card('c1'))).status).toBe(401)
    expect((await post(card('c1', 'new', { user_id: 'bob' }), 'alice')).status).toBe(403)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cards`).get()).toEqual({ n: 0 })
  })

  it("refuses an update or delete of someone else's row 403, and fans nothing out", async () => {
    const { post, connect } = await room()
    await post(card('c1'), 'bob')
    const bob = await connect('bob')
    const edit = await post([{ channel: 'cards', ops: [{ type: 'update', value: { id: 'c1', status: 'known' } }] }], 'alice')
    const drop = await post([{ channel: 'cards', ops: [{ type: 'delete', value: { id: 'c1' } }] }], 'alice')
    expect([edit.status, drop.status]).toEqual([403, 403])
    expect(edit.body).toMatchObject({ channel: 'cards' })
    expect(bob.frames.filter((f) => !f.reset)).toEqual([])
  })

  it('lets an owner update and delete their own row', async () => {
    const { post, db } = await room()
    await post(card('c1'), 'alice')
    expect((await post([{ channel: 'cards', ops: [{ type: 'update', value: { id: 'c1', status: 'known' } }] }], 'alice')).status).toBe(200)
    expect((await post([{ channel: 'cards', ops: [{ type: 'delete', value: { id: 'c1' } }] }], 'alice')).status).toBe(200)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cards`).get()).toEqual({ n: 0 })
  })

  it("keeps the catalog append-only: members add, nobody edits", async () => {
    const { post } = await room()
    expect((await post([{ channel: 'phrases', ops: [{ type: 'insert', value: { id: 'p1', text: 'hola' } }] }])).status).toBe(401)
    expect((await post([{ channel: 'phrases', ops: [{ type: 'insert', value: { id: 'p1', text: 'hola' } }] }], 'alice')).status).toBe(200)
    expect((await post([{ channel: 'phrases', ops: [{ type: 'update', value: { id: 'p1', text: 'adios' } }] }], 'alice')).status).toBe(403)
  })
})

describe('access — the reads', () => {
  it("gives each socket only its own user's rows in the snapshot, and everyone the catalog", async () => {
    const { post, connect } = await room()
    await post([{ channel: 'phrases', ops: [{ type: 'insert', value: { id: 'p1', text: 'hola' } }] }], 'alice')
    await post(card('a1'), 'alice')
    await post(card('b1'), 'bob')
    const [alice, bob, anon] = [await connect('alice'), await connect('bob'), await connect()]
    expect(ids(alice.frames, 'cards')).toEqual(['a1'])
    expect(ids(bob.frames, 'cards')).toEqual(['b1'])
    expect(ids(anon.frames, 'cards')).toEqual([])
    // the anonymous socket still gets the cards snapshot, empty, so the collection turns ready
    expect(anon.frames.find((f) => f.channel === 'cards')).toMatchObject({ ops: [], reset: true, ready: true })
    for (const s of [alice, bob, anon]) expect(ids(s.frames, 'phrases')).toEqual(['p1'])
  })

  it("fans a private row out to its owner's sockets only, and the catalog to everyone", async () => {
    const { post, connect } = await room()
    const [alice, alsoAlice, bob, anon] = [await connect('alice'), await connect('alice'), await connect('bob'), await connect()]
    const live = (s: Socket) => s.frames.filter((f) => !f.reset)
    await post(card('a1'), 'alice')
    expect(live(alice).map((f) => ids([f], 'cards'))).toEqual([['a1']])
    expect(live(alsoAlice)).toHaveLength(1)
    expect(live(bob)).toEqual([])
    expect(live(anon)).toEqual([])
    await post([{ channel: 'phrases', ops: [{ type: 'insert', value: { id: 'p1', text: 'hola' } }] }], 'bob')
    for (const s of [alice, bob, anon]) expect(ids(live(s), 'phrases')).toEqual(['p1'])
  })

  it('filters a reconnecting delta the same way', async () => {
    const { post, connect } = await room()
    await post(card('a1'), 'alice')
    await post(card('b1'), 'bob')
    await post(card('a2'), 'alice')
    const alice = await connect('alice', 0)
    expect(alice.frames.every((f) => !f.reset)).toBe(true)
    expect(ids(alice.frames, 'cards')).toEqual(['a1', 'a2'])
  })

  it("routes a delete by the stored row's owner, not the owner the client sent", async () => {
    const { post, connect } = await room()
    await post(card('a1'), 'alice')
    const [alice, bob] = [await connect('alice'), await connect('bob')]
    await post([{ channel: 'cards', ops: [{ type: 'delete', value: { id: 'a1', user_id: 'bob' } }] }], 'alice')
    expect(alice.frames.filter((f) => !f.reset).flatMap((f) => f.ops.map((o) => o.type))).toEqual(['delete'])
    expect(bob.frames.filter((f) => !f.reset)).toEqual([])
  })

  it('answers a write with only the batches the writer can read', async () => {
    const onlyAuthedInsert = definePartyCollection({
      name: 'cards',
      key: 'id',
      schema: cardSchema,
      ownerColumn: 'user_id',
      access: { read: 'owner', insert: 'authed' },
    })
    const { post } = await room({ collections: [phrases, onlyAuthedInsert] })
    // alice files a card for bob: the write commits, but alice will never read it back
    const res = await post(card('for-bob', 'new', { user_id: 'bob' }), 'alice')
    expect(res.status).toBe(200)
    expect(res.body.accepted).toEqual([])
    expect(res.body.changed).toEqual([])
  })

  it("fans a host-authored commit out by each row's owner", async () => {
    const { core, connect } = await room()
    const [alice, bob] = [await connect('alice'), await connect('bob')]
    await core.commit([
      {
        channel: 'cards',
        ops: [
          { type: 'insert', value: { id: 'a1', user_id: 'alice', status: 'new' } },
          { type: 'insert', value: { id: 'b1', user_id: 'bob', status: 'new' } },
        ],
      },
    ])
    expect(ids(alice.frames.filter((f) => !f.reset), 'cards')).toEqual(['a1'])
    expect(ids(bob.frames.filter((f) => !f.reset), 'cards')).toEqual(['b1'])
  })
})

describe('access — boot checks and back-compat', () => {
  it('refuses to start a private-read room with no broadcastTo', async () => {
    const { engine, db } = memoryEngine()
    db.exec(`CREATE TABLE cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL)`)
    const core = new PartyDbCore({ collections: [cards], adapter: new SqliteAdapter(engine, [cards]), broadcast: () => {} })
    await expect(core.init()).rejects.toThrow(/broadcastTo/)
  })

  it('refuses to start an owner update on an adapter that cannot read rows', async () => {
    const withoutReads = (a: SqliteAdapter): PersistenceAdapter => ({
      init: () => a.init(),
      write: (b) => a.write(b),
      snapshot: (c) => a.snapshot(c),
      replaySince: (s) => a.replaySince(s),
    })
    await expect(room({ adapter: withoutReads })).rejects.toThrow(/readRows/)
  })

  it('never calls auth on connect when every read is public', async () => {
    const todos = definePartyCollection({ name: 'phrases', key: 'id', schema: phraseSchema })
    const { engine, db } = memoryEngine()
    db.exec(`CREATE TABLE phrases (id TEXT PRIMARY KEY, text TEXT NOT NULL)`)
    const spy = vi.fn(auth)
    const core = new PartyDbCore({ collections: [todos], adapter: new SqliteAdapter(engine, [todos]), broadcast: () => {}, auth: () => spy })
    await core.init()
    const viewer: Viewer = await core.resolveViewer(new Request('https://example.com/?token=alice'))
    expect(viewer.uid).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('enforces an owner collection with no schema, in the blob store', async () => {
    const notes = definePartyCollection<{ id: string; owner?: string; body: string }>({ name: 'notes', key: 'id', ownerColumn: 'owner' })
    const { post, connect } = await room({ collections: [notes] })
    await post([{ channel: 'notes', ops: [{ type: 'insert', value: { id: 'n1', body: 'mine' } }] }], 'alice')
    const [alice, bob] = [await connect('alice'), await connect('bob')]
    expect(alice.frames.find((f) => f.channel === 'notes')?.ops.map((o) => o.value)).toEqual([{ id: 'n1', body: 'mine', owner: 'alice' }])
    expect(bob.frames.find((f) => f.channel === 'notes')?.ops).toEqual([])
    expect((await post([{ channel: 'notes', ops: [{ type: 'update', value: { id: 'n1', body: 'theirs' } }] }], 'bob')).status).toBe(403)
  })
})
