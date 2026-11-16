// Read slicing at the core (docs/architecture.md §18): subscribe replies, routing
// a write to the sockets watching its slice, and the index surviving a wake.
// Driven through a composed host over a real in-memory SQLite.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { PartyDbCore } from '../src/server/core.ts'
import { SqliteAdapter } from '../src/server/sqlite-adapter.ts'
import { ANONYMOUS } from '../src/server/access.ts'
import { definePartyCollection, type PartyCollection } from '../src/schema.ts'
import type { PartyDbConnection, Subscription } from '../src/server/slices.ts'
import type { SequencedBatch, UpFrame, WriteBatch, WriteReject } from '../src/protocol.ts'
import { memoryEngine } from './helpers/sql-engine.ts'

const comments = definePartyCollection({
  name: 'comments',
  key: 'id',
  schema: z.object({ id: z.string(), thread_id: z.string(), body: z.string() }),
  sliceBy: 'thread_id',
})
const todos = definePartyCollection({ name: 'todos', key: 'id', schema: z.object({ id: z.string(), text: z.string() }) })

// A socket with the slot partyserver keeps across hibernation.
type Socket = PartyDbConnection & { frames: SequencedBatch[]; slot: Subscription[] | null }

function socket(id: string): Socket {
  const s: Socket = {
    id,
    viewer: ANONYMOUS,
    frames: [],
    slot: null,
    send: (m) => void s.frames.push(JSON.parse(m)),
    loadSubscriptions: () => s.slot,
    saveSubscriptions: (subs) => void (s.slot = subs),
  }
  return s
}

async function room(opts: { routed?: boolean; collections?: PartyCollection<any>[] } = {}) {
  const { engine, db } = memoryEngine()
  db.exec(`CREATE TABLE comments (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL)`)
  db.exec(`CREATE TABLE drafts (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, user_id TEXT NOT NULL)`)
  db.exec(`CREATE TABLE reactions (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL)`)
  db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL)`)
  const cols = opts.collections ?? [comments, todos]
  const sockets: Socket[] = []
  const broadcasts: SequencedBatch[] = []
  const build = async () => {
    const core = new PartyDbCore({
      collections: cols,
      adapter: new SqliteAdapter(engine, cols),
      broadcast: (m) => {
        broadcasts.push(JSON.parse(m))
        for (const s of sockets) s.send(m)
      },
      ...(opts.routed === false ? {} : { connections: () => sockets }),
    })
    await core.init()
    return core
  }
  let core = await build()
  const url = (since?: number) => `https://example.com/parties/main/room${since === undefined ? '' : `?since=${since}`}`
  return {
    get core() {
      return core
    },
    sockets,
    broadcasts,
    // a fresh isolate over the same storage and the same live sockets
    wake: async () => void (core = await build()),
    connect: async (id: string, since?: number, uid: string | null = null) => {
      const s = socket(id)
      s.viewer = { uid }
      sockets.push(s)
      await core.connect(opts.routed === false ? s.send : s, url(since))
      return s
    },
    frame: (s: Socket, frame: UpFrame) => core.handleMessage(opts.routed === false ? s.send : s, JSON.stringify(frame)),
    write: (body: WriteBatch[]) => core.commit(body),
    post: (body: WriteBatch[]) => core.handleWrite(new Request(url(), { method: 'POST', body: JSON.stringify(body) })),
  }
}

const comment = (id: string, thread_id: string, body = id): WriteBatch[] => [
  { channel: 'comments', ops: [{ type: 'insert', value: { id, thread_id, body } }] },
]
const idsIn = (frames: SequencedBatch[], channel = 'comments') => frames.filter((f) => f.channel === channel).flatMap((f) => f.ops.map((op) => op.value.id))

describe('a sliced collection loads by subscription', () => {
  it('sends nothing for the sliced channel on connect, and the rest as before', async () => {
    const r = await room()
    await r.write(comment('c1', 'A'))
    const s = await r.connect('s')
    expect(s.frames.map((f) => f.channel)).toEqual(['todos'])
  })

  it('leaves sliced ops out of the connect-time delta too', async () => {
    const r = await room()
    await r.write([{ channel: 'todos', ops: [{ type: 'insert', value: { id: 't0', text: 'x' } }] }])
    await r.write(comment('c1', 'A'))
    const s = await r.connect('s', 0)
    expect(s.frames.map((f) => f.channel)).toEqual(['todos'])
  })

  it('answers a slice subscribe with that slice alone, marked reset, ready and slice', async () => {
    const r = await room()
    await r.write(comment('c1', 'A'))
    await r.write(comment('c2', 'B'))
    const s = await r.connect('s')
    s.frames.length = 0
    await r.frame(s, { subscribe: 'comments', slice: 'A' })
    expect(s.frames).toEqual([{ channel: 'comments', seq: 2, ops: [{ type: 'insert', value: { id: 'c1', thread_id: 'A', body: 'c1' } }], ready: true, reset: true, slice: 'A' }])
  })

  it('answers a cursored subscribe with the slice delta, then a ready marker', async () => {
    const r = await room()
    await r.write(comment('c1', 'A'))
    await r.write(comment('c2', 'B'))
    await r.write(comment('c3', 'A'))
    const s = await r.connect('s')
    s.frames.length = 0
    await r.frame(s, { subscribe: 'comments', slice: 'A', since: 1 })
    expect(s.frames).toEqual([
      { channel: 'comments', seq: 3, ops: [{ type: 'insert', value: { id: 'c3', thread_id: 'A', body: 'c3' } }], slice: 'A' },
      { channel: 'comments', seq: 3, ops: [], ready: true, slice: 'A' },
    ])
  })

  it('answers a whole-channel subscribe with the whole channel', async () => {
    const r = await room()
    await r.write(comment('c1', 'A'))
    await r.write(comment('c2', 'B'))
    const s = await r.connect('s')
    s.frames.length = 0
    await r.frame(s, { subscribe: 'comments' })
    expect(idsIn(s.frames)).toEqual(['c1', 'c2'])
    expect(s.frames[0]).toMatchObject({ reset: true, ready: true })
    expect(s.frames[0]).not.toHaveProperty('slice')
  })
})

describe('routing a write to the sockets watching its slice', () => {
  it('sends a write only to the sockets subscribed to its slice or the whole channel', async () => {
    const r = await room()
    const [a, b, whole, none] = [await r.connect('a'), await r.connect('b'), await r.connect('whole'), await r.connect('none')]
    await r.frame(a, { subscribe: 'comments', slice: 'A' })
    await r.frame(b, { subscribe: 'comments', slice: 'B' })
    await r.frame(whole, { subscribe: 'comments' })
    for (const s of r.sockets) s.frames.length = 0

    await r.write(comment('c1', 'A'))
    expect(idsIn(a.frames)).toEqual(['c1'])
    expect(idsIn(b.frames)).toEqual([])
    expect(idsIn(whole.frames)).toEqual(['c1'])
    expect(idsIn(none.frames)).toEqual([])
    expect(r.broadcasts).toEqual([])
  })

  it('stops after an unsubscribe, and forgets a socket on disconnect', async () => {
    const r = await room()
    const a = await r.connect('a')
    const b = await r.connect('b')
    await r.frame(a, { subscribe: 'comments', slice: 'A' })
    await r.frame(b, { subscribe: 'comments', slice: 'A' })
    await r.frame(a, { unsubscribe: 'comments', slice: 'A' })
    r.core.disconnect('b')
    a.frames.length = b.frames.length = 0
    await r.write(comment('c1', 'A'))
    expect(a.frames).toEqual([])
    expect(b.frames).toEqual([])
  })

  it('keeps routing after a wake, rebuilt from what each socket saved', async () => {
    const r = await room()
    const a = await r.connect('a')
    const b = await r.connect('b')
    await r.frame(a, { subscribe: 'comments', slice: 'A' })
    expect(a.slot).toEqual([['comments', 'A']])
    expect(b.slot).toEqual([])

    await r.wake()
    a.frames.length = b.frames.length = 0
    await r.write(comment('c1', 'A'))
    expect(idsIn(a.frames)).toEqual(['c1'])
    expect(idsIn(b.frames)).toEqual([])
  })

  it('sends every sliced channel whole to a socket whose saved slot was lost', async () => {
    const r = await room()
    const a = await r.connect('a')
    a.slot = null // the app replaced the connection state wholesale
    await r.wake()
    a.frames.length = 0
    await r.write(comment('c1', 'Z'))
    expect(idsIn(a.frames)).toEqual(['c1'])
  })

  it('folds a socket past the subscription cap into one whole-channel subscription', async () => {
    const r = await room()
    const a = await r.connect('a')
    for (let i = 0; i < 101; i++) await r.frame(a, { subscribe: 'comments', slice: `t${i}` })
    expect(a.slot).toEqual([['comments', null]])
  })

  it('falls back to the host broadcast when the host gives no connections', async () => {
    const r = await room({ routed: false })
    const a = await r.connect('a')
    await r.frame(a, { subscribe: 'comments', slice: 'A' })
    a.frames.length = 0
    await r.write(comment('c1', 'B'))
    // every slice reaches every socket; the client drops what it did not ask for
    expect(idsIn(a.frames)).toEqual(['c1'])
    expect(idsIn(r.broadcasts)).toEqual(['c1'])
  })
})

describe('the slice column never changes', () => {
  it('refuses an update that carries the slice column', async () => {
    const r = await room()
    await r.write(comment('c1', 'A'))
    const res = await r.post([{ channel: 'comments', ops: [{ type: 'update', value: { id: 'c1', thread_id: 'B' } }] }])
    expect(res.status).toBe(400)
    expect(((await res.json()) as WriteReject).error).toMatch(/slice column "thread_id" cannot change/)
  })

  it('accepts an update to the other columns', async () => {
    const r = await room()
    await r.write(comment('c1', 'A'))
    const res = await r.post([{ channel: 'comments', ops: [{ type: 'update', value: { id: 'c1', body: 'edited' } }] }])
    expect(res.status).toBe(200)
  })

  it('refuses to start on a sliceBy the schema does not declare', async () => {
    const bad = definePartyCollection({ name: 'comments', key: 'id', schema: z.object({ id: z.string() }), sliceBy: 'thread_id' as never })
    await expect(room({ collections: [bad] })).rejects.toThrow(/sliceBy "thread_id", which its schema does not declare/)
  })
})

describe('access policies still apply inside a slice', () => {
  const drafts = definePartyCollection({
    name: 'drafts',
    key: 'id',
    schema: z.object({ id: z.string(), thread_id: z.string(), user_id: z.string() }),
    ownerColumn: 'user_id',
    sliceBy: 'thread_id',
  })
  const draft = (id: string, user_id: string): WriteBatch[] => [{ channel: 'drafts', ops: [{ type: 'insert', value: { id, thread_id: 'A', user_id } }] }]

  it("sends each socket only its own rows of the slice, in the reply and on fan-out", async () => {
    const r = await room({ collections: [drafts] })
    await r.write(draft('d1', 'alice'))
    await r.write(draft('d2', 'bob'))
    const alice = await r.connect('alice', undefined, 'alice')
    const bob = await r.connect('bob', undefined, 'bob')
    await r.frame(alice, { subscribe: 'drafts', slice: 'A' })
    await r.frame(bob, { subscribe: 'drafts', slice: 'A', since: 0 })
    expect(idsIn(alice.frames, 'drafts')).toEqual(['d1'])
    expect(idsIn(bob.frames, 'drafts')).toEqual(['d2'])
    expect(bob.frames.at(-1)).toMatchObject({ ready: true, slice: 'A' })

    await r.write(draft('d3', 'bob'))
    expect(idsIn(alice.frames, 'drafts')).toEqual(['d1'])
    expect(idsIn(bob.frames, 'drafts')).toEqual(['d2', 'd3'])
  })
})

describe('the adapter reads only what a subscribe or a connect needs', () => {
  it('replays one channel when asked, and every channel but the sliced ones when not', async () => {
    const { engine, db } = memoryEngine()
    db.exec(`CREATE TABLE comments (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL)`)
    db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL)`)
    const adapter = new SqliteAdapter(engine, [comments, todos])
    await adapter.init()
    await adapter.write(comment('c1', 'A'))
    await adapter.write([{ channel: 'todos', ops: [{ type: 'insert', value: { id: 't1', text: 'x' } }] }])
    expect((await adapter.replaySince(0, 'comments'))!.map((b) => b.channel)).toEqual(['comments'])
    expect((await adapter.replaySince(0))!.map((b) => b.channel)).toEqual(['todos'])
  })

  it('refuses a sliceBy column that cannot hold an id', async () => {
    const flagged = definePartyCollection({
      name: 'comments',
      key: 'id',
      schema: z.object({ id: z.string(), thread_id: z.boolean(), body: z.string() }),
      sliceBy: 'thread_id' as never,
    })
    await expect(room({ collections: [flagged] })).rejects.toThrow(/sliceBy "thread_id", which its schema types as boolean/)
  })
})

describe('review fixes: routing keeps every slice a client still holds', () => {
  it('keeps a slice subscribed after the same socket drops its whole-channel subscription', async () => {
    const r = await room()
    const s = await r.connect('s')
    await r.frame(s, { subscribe: 'comments' })
    await r.frame(s, { subscribe: 'comments', slice: 'A' })
    await r.frame(s, { unsubscribe: 'comments' })
    s.frames.length = 0
    await r.write(comment('c1', 'A'))
    expect(idsIn(s.frames)).toEqual(['c1'])
  })

  it('routes a delete by the stored row, not the slice the client sent', async () => {
    const r = await room()
    await r.write(comment('c1', 'A'))
    const a = await r.connect('a')
    const z = await r.connect('z')
    await r.frame(a, { subscribe: 'comments', slice: 'A' })
    await r.frame(z, { subscribe: 'comments', slice: 'Z' })
    a.frames.length = z.frames.length = 0
    const res = await r.post([{ channel: 'comments', ops: [{ type: 'delete', value: { id: 'c1', thread_id: 'Z', body: 'c1' } }] }])
    expect(res.status).toBe(200)
    expect(a.frames.flatMap((f) => f.ops)).toEqual([{ type: 'delete', value: { id: 'c1', thread_id: 'A', body: 'c1' } }])
    expect(z.frames).toEqual([])
  })

  it('applies an unsubscribe after the subscribe the socket sent before it', async () => {
    const r = await room()
    const s = await r.connect('s')
    await Promise.all([r.frame(s, { subscribe: 'comments', slice: 'A' }), r.frame(s, { unsubscribe: 'comments', slice: 'A' })])
    expect(s.slot).toEqual([])
    s.frames.length = 0
    await r.write(comment('c1', 'A'))
    expect(s.frames).toEqual([])
  })

  it('folds to whole channels when the slot would outgrow its budget', async () => {
    const r = await room()
    const s = await r.connect('s')
    await r.frame(s, { subscribe: 'comments', slice: 'x'.repeat(10_000) })
    expect(s.slot).toEqual([['comments', null]])
  })

  it('counts the slice cap per channel', async () => {
    const reactions = definePartyCollection({
      name: 'reactions',
      key: 'id',
      schema: z.object({ id: z.string(), thread_id: z.string() }),
      sliceBy: 'thread_id',
    })
    const r = await room({ collections: [comments, reactions] })
    const s = await r.connect('s')
    for (let i = 0; i < 100; i++) await r.frame(s, { subscribe: 'comments', slice: `t${i}` })
    await r.frame(s, { subscribe: 'reactions', slice: 'A' })
    expect(s.slot!.filter(([channel]) => channel === 'reactions')).toEqual([['reactions', 'A']])
  })
})
