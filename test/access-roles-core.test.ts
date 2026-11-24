// Role grants at the core's four choke points, through a composed host over a
// real in-memory SQLite. Each socket is a `PartyDbConnection`, so the core can
// fan an owner-or-role collection out per socket. The test's token is
// `<uid>` or `<uid>:<role>,<role>`; a real app verifies a JWT and reads
// `sub` and `roles` from its claims.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { PartyDbCore } from '../src/server/core.ts'
import { SqliteAdapter } from '../src/server/sqlite-adapter.ts'
import { audienceTag, viewerFromTags, viewerTags } from '../src/server/access.ts'
import { bearer } from '../src/server/auth.ts'
import { definePartyCollection, type PartyCollection } from '../src/schema.ts'
import type { PartyDbConnection } from '../src/server/slices.ts'
import type { WriteIdentity } from '../src/server/persistence.ts'
import type { SequencedBatch, WriteAck, WriteBatch, WriteReject } from '../src/protocol.ts'
import { memoryEngine } from './helpers/sql-engine.ts'

const reviewSchema = z.object({ id: z.string(), reviewed_by: z.string().optional(), text: z.string() })
const draftSchema = z.object({ id: z.string(), text: z.string() })

const reviews = definePartyCollection({
  name: 'reviews',
  key: 'id',
  schema: reviewSchema,
  ownerColumn: 'reviewed_by',
  access: { read: 'public', insert: 'owner', update: { owner: true, roles: ['editor'] }, delete: { owner: true, roles: ['editor'] } },
})
const drafts = definePartyCollection({ name: 'drafts', key: 'id', schema: draftSchema, access: { roles: ['editor'] } })
const notes = definePartyCollection({ name: 'notes', key: 'id', schema: reviewSchema, ownerColumn: 'reviewed_by', access: { owner: true, roles: ['editor'] } })
const memos = definePartyCollection({ name: 'memos', key: 'id', schema: draftSchema, access: { read: { roles: ['editor', 'admin'] } } })
const collections: PartyCollection<any>[] = [reviews, drafts, notes, memos]

const auth = (req: Request): WriteIdentity | null => {
  const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
  if (!token) return null
  const [sub, roles] = token.split(':')
  return { claims: { sub, roles: roles ? roles.split(',') : [] } }
}

type Socket = PartyDbConnection & { tags: string[]; frames: SequencedBatch[] }

async function room(opts: { connections?: boolean } = {}) {
  const { engine, db } = memoryEngine()
  db.exec(`CREATE TABLE reviews (id TEXT PRIMARY KEY, reviewed_by TEXT NOT NULL, text TEXT NOT NULL)`)
  db.exec(`CREATE TABLE drafts (id TEXT PRIMARY KEY, text TEXT NOT NULL)`)
  db.exec(`CREATE TABLE memos (id TEXT PRIMARY KEY, text TEXT NOT NULL)`)
  db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, reviewed_by TEXT NOT NULL, text TEXT NOT NULL)`)
  const sockets: Socket[] = []
  const asked: unknown[] = []
  const core = new PartyDbCore({
    collections,
    adapter: new SqliteAdapter(engine, collections),
    broadcast: (m, audience) => {
      const to = audience === 'all' ? sockets : sockets.filter((s) => s.tags.includes(audienceTag(audience)))
      to.forEach((s) => s.frames.push(JSON.parse(m)))
    },
    auth: () => auth,
    ...(opts.connections === false
      ? {}
      : {
          connections: (audience) => {
            asked.push(audience)
            return audience ? sockets.filter((s) => s.tags.includes(audienceTag(audience))) : sockets
          },
        }),
  })
  await core.init()

  let next = 0
  const connect = async (token?: string, since?: number) => {
    const url = `https://example.com/parties/main/room?${new URLSearchParams({ ...(token ? { token } : {}), ...(since !== undefined ? { since: String(since) } : {}) })}`
    const tags = viewerTags(await core.resolveViewer(new Request(url)))
    const socket: Socket = {
      id: `conn-${next++}`,
      tags,
      frames: [],
      viewer: viewerFromTags(tags),
      send: (m) => socket.frames.push(JSON.parse(m)),
      loadSubscriptions: () => null,
      saveSubscriptions: () => {},
    }
    await core.connect(socket, url)
    sockets.push(socket)
    return socket
  }
  const close = (socket: Socket) => sockets.splice(sockets.indexOf(socket), 1)
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
  return { core, db, connect, close, post, asked }
}

const op = (channel: string, type: 'insert' | 'update' | 'delete', value: Record<string, unknown>): WriteBatch[] => [
  { channel, ops: [{ type, value }] },
]
const ids = (frames: SequencedBatch[], channel: string) =>
  frames.filter((f) => f.channel === channel).flatMap((f) => f.ops.map((o) => `${o.type}:${o.value.id}`))
const live = (frames: SequencedBatch[]) => frames.filter((f) => !f.reset)
const last = (frames: SequencedBatch[]) => frames.at(-1)!.seq as number

const ANON = undefined
const BOB = 'bob' // a uid without the role
const CAROL = 'carol:editor' // a uid with it
const ALICE = 'alice' // the row's owner

describe('role grants — the write gate, every verb', () => {
  it('lets only an editor insert, update and delete a draft', async () => {
    const { post } = await room()
    const statuses = async (type: 'insert' | 'update' | 'delete', value: Record<string, unknown>) =>
      Promise.all([ANON, BOB, ALICE].map(async (t) => (await post(op('drafts', type, value), t)).status))
    expect(await statuses('insert', { id: 'd1', text: 'x' })).toEqual([401, 403, 403])
    expect((await post(op('drafts', 'insert', { id: 'd1', text: 'x' }), CAROL)).status).toBe(200)
    expect(await statuses('update', { id: 'd1', text: 'y' })).toEqual([401, 403, 403])
    expect((await post(op('drafts', 'update', { id: 'd1', text: 'y' }), CAROL)).status).toBe(200)
    expect(await statuses('delete', { id: 'd1' })).toEqual([401, 403, 403])
    expect((await post(op('drafts', 'delete', { id: 'd1' }), CAROL)).status).toBe(200)
  })

  it('lets the owner or an editor update and delete a review, and refuses anyone else by the stored row', async () => {
    const { post, db } = await room()
    expect((await post(op('reviews', 'insert', { id: 'r1', text: 'good' }), ALICE)).status).toBe(200)
    expect((await post(op('reviews', 'insert', { id: 'r2', text: 'fine' }), ALICE)).status).toBe(200)
    expect((await post(op('reviews', 'update', { id: 'r1', text: 'mine' }), ANON)).status).toBe(401)
    expect((await post(op('reviews', 'update', { id: 'r1', text: 'mine' }), BOB)).status).toBe(403)
    expect((await post(op('reviews', 'delete', { id: 'r1' }), BOB)).status).toBe(403)
    expect((await post(op('reviews', 'update', { id: 'r1', text: 'edited' }), ALICE)).status).toBe(200)
    expect((await post(op('reviews', 'update', { id: 'r1', text: 'overridden' }), CAROL)).status).toBe(200)
    expect((await post(op('reviews', 'delete', { id: 'r2' }), CAROL)).status).toBe(200)
    expect((await post(op('reviews', 'delete', { id: 'r1' }), ALICE)).status).toBe(200)
    expect(db.prepare('SELECT id FROM reviews').all()).toEqual([])
  })

  it('keeps reviews insertable by their owner only, since insert names no role', async () => {
    const { post, db } = await room()
    expect((await post(op('reviews', 'insert', { id: 'r1', text: 'x' }), ANON)).status).toBe(401)
    expect((await post(op('reviews', 'insert', { id: 'r1', reviewed_by: 'alice', text: 'x' }), CAROL)).status).toBe(403)
    expect((await post(op('reviews', 'insert', { id: 'r1', text: 'x' }), CAROL)).status).toBe(200)
    expect(db.prepare('SELECT reviewed_by FROM reviews').get()).toEqual({ reviewed_by: 'carol' })
  })

  it('judges a write by the roles in that POST, not the ones on the socket', async () => {
    const { post } = await room()
    expect((await post(op('drafts', 'insert', { id: 'd1', text: 'x' }), 'bob:editor')).status).toBe(200)
    expect((await post(op('drafts', 'update', { id: 'd1', text: 'y' }), BOB)).status).toBe(403)
  })
})

describe('role grants — the reads', () => {
  async function seeded() {
    const r = await room()
    await r.post(op('drafts', 'insert', { id: 'd1', text: 'x' }), CAROL)
    await r.post(op('notes', 'insert', { id: 'n-alice', text: 'a' }), ALICE)
    await r.post(op('notes', 'insert', { id: 'n-bob', text: 'b' }), BOB)
    return r
  }

  it('snapshots drafts to editors only, and notes to their owner or an editor', async () => {
    const { connect } = await seeded()
    const [anon, bob, carol, alice] = [await connect(ANON), await connect(BOB), await connect(CAROL), await connect(ALICE)]
    expect([anon, bob, carol, alice].map((s) => ids(s.frames, 'drafts'))).toEqual([[], [], ['insert:d1'], []])
    expect([anon, bob, carol, alice].map((s) => ids(s.frames, 'notes'))).toEqual([[], ['insert:n-bob'], ['insert:n-alice', 'insert:n-bob'], ['insert:n-alice']])
  })

  it('replays a ?since delta under the same rules', async () => {
    const { connect, post } = await seeded()
    const cursor = last((await connect(CAROL)).frames)
    await post(op('drafts', 'insert', { id: 'd2', text: 'x' }), CAROL)
    await post(op('notes', 'insert', { id: 'n-alice-2', text: 'a' }), ALICE)
    const [anon, bob, carol, alice] = [await connect(ANON, cursor), await connect(BOB, cursor), await connect(CAROL, cursor), await connect(ALICE, cursor)]
    expect([anon, bob, carol, alice].map((s) => ids(s.frames, 'drafts'))).toEqual([[], [], ['insert:d2'], []])
    expect([anon, bob, carol, alice].map((s) => ids(s.frames, 'notes'))).toEqual([[], [], ['insert:n-alice-2'], ['insert:n-alice-2']])
  })

  it('fans a draft out to the editor role, and a note to its owner and editors', async () => {
    const { connect, post } = await room()
    const [anon, bob, carol, alice] = [await connect(ANON), await connect(BOB), await connect(CAROL), await connect(ALICE)]
    await post(op('drafts', 'insert', { id: 'd1', text: 'x' }), CAROL)
    await post(op('notes', 'insert', { id: 'n1', text: 'a' }), ALICE)
    expect([anon, bob, carol, alice].map((s) => ids(live(s.frames), 'drafts'))).toEqual([[], [], ['insert:d1'], []])
    expect([anon, bob, carol, alice].map((s) => ids(live(s.frames), 'notes'))).toEqual([[], [], ['insert:n1'], ['insert:n1']])
  })

  it('sends an editor who owns the note one frame, not one as owner and one as editor', async () => {
    const { connect, post } = await room()
    const dana = await connect('dana:editor')
    await post(op('notes', 'insert', { id: 'n1', text: 'mine' }), 'dana:editor')
    expect(live(dana.frames).filter((f) => f.channel === 'notes')).toHaveLength(1)
    expect(ids(live(dana.frames), 'notes')).toEqual(['insert:n1'])
  })

  it('looks up only the sockets of the roles and owners a note can reach, never the whole room', async () => {
    const { connect, post, asked } = await room()
    await connect(BOB)
    await post(op('notes', 'insert', { id: 'n1', text: 'a' }), ALICE)
    expect(asked).toEqual([{ role: 'editor' }, { uid: 'alice' }])
  })

  it('refuses to start a room that names more roles than a socket can pin', async () => {
    const { engine } = memoryEngine()
    const many = definePartyCollection({ name: 'drafts', key: 'id', schema: draftSchema, access: { roles: Array.from({ length: 8 }, (_, i) => `r${i}`) } })
    const core = new PartyDbCore({ collections: [many], adapter: new SqliteAdapter(engine, [many]), broadcast: () => {}, auth: () => auth, connections: () => [] })
    await expect(core.init()).rejects.toThrow(/name 8 roles/)
  })

  it('sends a two-role read once to a socket holding both roles, and once to each single holder', async () => {
    const { core, connect } = await room()
    const [both, editor, admin, bob] = [await connect('erin:editor,admin'), await connect(CAROL), await connect('ada:admin'), await connect(BOB)]
    await core.commit([{ channel: 'memos', ops: [{ type: 'insert', value: { id: 'm1', text: 'x' } }] }])
    expect([both, editor, admin, bob].map((s) => live(s.frames).filter((f) => f.channel === 'memos').length)).toEqual([1, 1, 1, 0])
  })

  it('tells the owner a note is gone when an editor deletes it', async () => {
    const { connect, post } = await room()
    await post(op('notes', 'insert', { id: 'n1', text: 'a' }), ALICE)
    const [alice, bob] = [await connect(ALICE), await connect(BOB)]
    expect((await post(op('notes', 'delete', { id: 'n1' }), CAROL)).status).toBe(200)
    expect(ids(live(alice.frames), 'notes')).toEqual(['delete:n1'])
    expect(ids(live(bob.frames), 'notes')).toEqual([])
  })

  it("answers an editor's write with the batches an editor reads", async () => {
    const { post } = await room()
    const { body } = await post(op('notes', 'insert', { id: 'n1', reviewed_by: 'alice', text: 'a' }), CAROL)
    expect(body.accepted.map((a) => a.channel)).toEqual(['notes'])
    expect((await post(op('drafts', 'insert', { id: 'd1', text: 'x' }), CAROL)).body.accepted).toHaveLength(1)
  })

  it('refuses to start an owner-or-role read without connections to send each socket its own frame', async () => {
    await expect(room({ connections: false })).rejects.toThrow(/"notes".*connections/)
  })
})

describe('role grants — a socket keeps its roles until it reconnects', () => {
  it('reads drafts under the roles it connected with, and the new ones after reconnect', async () => {
    const { connect, close, post } = await room()
    await post(op('drafts', 'insert', { id: 'd1', text: 'x' }), CAROL)
    // bob is made an editor after his socket connected: the socket still reads as
    // a uid without the role.
    const before = await connect(BOB)
    await post(op('drafts', 'insert', { id: 'd2', text: 'x' }), CAROL)
    expect(ids(before.frames, 'drafts')).toEqual([])
    close(before)
    const after = await connect('bob:editor')
    expect(ids(after.frames, 'drafts')).toEqual(['insert:d1', 'insert:d2'])
    // and back: the role revoked, a fresh connect (no ?since) gets an empty reset.
    close(after)
    const revoked = await connect(BOB)
    expect(revoked.frames.find((f) => f.channel === 'drafts')).toMatchObject({ reset: true, ops: [] })
  })

  it('pins only the roles some collection names', async () => {
    const { connect } = await room()
    const socket = await connect('carol:editor,cook,baker')
    expect(socket.viewer.roles).toEqual(['editor'])
  })
})
