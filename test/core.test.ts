// PartyDbCore composed, not subclassed: a bare host object holds the core and
// hands it lifecycle events — no partyserver `Server` anywhere in this file.
// This is the seam for a host that already extends another `Server` (an
// agents-SDK AIChatAgent) and therefore cannot extend `PartyDbServer` — see
// docs/architecture.md §15. The deep write/replay semantics are pinned by the
// adapter and integration suites; this suite pins the composed surface itself.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { PartyDbCore, type AuthHook } from '../src/server/core.ts'
import { SqliteAdapter } from '../src/server/sqlite-adapter.ts'
import { definePartyCollection } from '../src/schema.ts'
import { memoryEngine } from './helpers/sql-engine.ts'
import type { SequencedBatch, WriteAck, WriteBatch } from '../src/protocol.ts'

const todoSchema = z.object({ id: z.string(), text: z.string(), done: z.boolean().optional() })
const collections = [definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema })]

// the host: it owns the storage and the "sockets" (here, an array of frames).
// Initialized, as a real host's onStart leaves it — no test exercises pre-init.
async function host(opts: { auth?: () => AuthHook | undefined } = {}) {
  const { engine, db } = memoryEngine()
  db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`)
  const broadcasts: SequencedBatch[] = []
  const core = new PartyDbCore({
    collections,
    adapter: new SqliteAdapter(engine, collections),
    broadcast: (message) => broadcasts.push(JSON.parse(message)),
    ...opts,
  })
  await core.init()
  return { core, db, broadcasts }
}

const write = (id: string, text: string): WriteBatch[] => [{ channel: 'todos', ops: [{ type: 'insert', value: { id, text } }] }]

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://example.com/parties/main/room', { method: 'POST', headers, body: JSON.stringify(body) })

describe('PartyDbCore — composed into a host that cannot subclass', () => {
  it('init creates the _oplog in the host-built adapter', async () => {
    const { core, db } = await host()
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r: any) => r.name)
    expect(tables).toContain('_oplog')
  })

  it('handleWrite commits, acks the resolved row, and fans out through the host broadcast', async () => {
    const { core, broadcasts } = await host()
    const res = await core.handleWrite(post(write('a', 'compose')))
    expect(res.status).toBe(200)
    const ack = (await res.json()) as WriteAck
    // the resolved row carries the table default the client never sent
    expect(ack.changed![0].ops[0].value).toMatchObject({ id: 'a', text: 'compose', done: false })
    expect(ack.accepted).toEqual([{ channel: 'todos', seq: broadcasts[0].seq }])
    // the frame the host broadcast is the same sequenced batch, unwrapped raw wire
    expect(broadcasts).toEqual(ack.changed)
  })

  it('commit sequences and fans out a write the host itself authors', async () => {
    const { core, broadcasts } = await host()
    const sequenced = await core.commit(write('h', 'host-authored'))
    expect(sequenced[0].seq).toBeGreaterThan(0)
    expect(broadcasts).toEqual(sequenced)
  })

  it('connect sends a fresh client the snapshot and a cursored client only the delta', async () => {
    const { core } = await host()
    await core.commit(write('a', 'one'))
    const [{ seq }] = await core.commit(write('b', 'two'))

    const connectFrames = async (query = '') => {
      const frames: SequencedBatch[] = []
      await core.connect((m) => frames.push(JSON.parse(m)), `https://example.com/parties/main/room${query}`)
      return frames
    }

    const fresh = await connectFrames()
    expect(fresh[0].ops.map((op) => (op.value as any).id).sort()).toEqual(['a', 'b'])

    const behindByOne = await connectFrames(`?since=${Number(seq) - 1}`)
    expect(behindByOne).toHaveLength(1)
    expect(behindByOne[0].ops[0].value).toMatchObject({ id: 'b' })

    const current = await connectFrames(`?since=${seq}`)
    expect(current).toHaveLength(0)
  })

  it('rejects an unknown channel 400 and a non-POST 404 without touching the adapter', async () => {
    const { core, broadcasts } = await host()
    const bad = await core.handleWrite(post([{ channel: 'nope', ops: [] }]))
    expect(bad.status).toBe(400)
    const get = await core.handleWrite(new Request('https://example.com/parties/main/room'))
    expect(get.status).toBe(404)
    expect(broadcasts).toHaveLength(0)
  })

  it('fails closed: with auth set and no identity resolved, the write is rejected 401', async () => {
    const { core, broadcasts } = await host({ auth: () => () => null })
    const res = await core.handleWrite(post(write('x', 'anon')))
    expect(res.status).toBe(401)
    expect(broadcasts).toHaveLength(0)
  })

  it('reads auth presence per write: a hook that appears after boot gates from then on', async () => {
    let hook: AuthHook | undefined
    const { core } = await host({ auth: () => hook })
    expect((await core.handleWrite(post(write('a', 'open')))).status).toBe(200)
    hook = () => null
    expect((await core.handleWrite(post(write('b', 'gated')))).status).toBe(401)
  })

  it('answers a missed update 409 with code missing-row, broadcasting nothing', async () => {
    const { core, broadcasts } = await host()
    const res = await core.handleWrite(
      post([{ channel: 'todos', ops: [{ type: 'update', value: { id: 'ghost', done: true } }] }]),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'update matched no row (channel "todos", key "ghost")',
      channel: 'todos',
      code: 'missing-row',
    })
    expect(broadcasts).toHaveLength(0)
    // and the room keeps serving
    expect((await core.handleWrite(post(write('next', 'still serving')))).status).toBe(200)
  })

  it('handleMessage answers a snapshot request with that channel alone, to the asking connection', async () => {
    const { core, broadcasts } = await host()
    await core.commit(write('a', 'one'))
    const frames: SequencedBatch[] = []
    await core.handleMessage((m) => frames.push(JSON.parse(m)), JSON.stringify({ snapshot: 'todos' }))

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ channel: 'todos', reset: true, ready: true })
    expect(frames[0].ops.map((op) => (op.value as any).id)).toEqual(['a'])
    // the reply went to this connection only — nothing was fanned out
    expect(broadcasts).toHaveLength(1) // the commit above, and nothing since
  })

  it('handleMessage drops an unknown channel and any frame that is not a snapshot request', async () => {
    const { core } = await host()
    const frames: string[] = []
    const send = (m: string) => void frames.push(m)
    for (const message of [
      JSON.stringify({ snapshot: 'nope' }), // a channel this room does not serve
      JSON.stringify({ snapshot: 42 }), // right key, wrong type
      JSON.stringify({ cf_agent_use_chat_request: 'x' }), // a composed host's own frame
      'not json at all',
      new ArrayBuffer(4), // a binary frame
    ]) {
      await core.handleMessage(send, message)
    }
    expect(frames).toEqual([])
  })

  it('handleMessage serializes with a concurrent commit: the snapshot never lands before a seq it already carries', async () => {
    const { core, broadcasts } = await host()
    await core.commit(write('a', 'one'))
    // the connection sees both the fan-out and its own snapshot reply, so collect
    // them in one list — that list is what ordering is about.
    const frames = broadcasts
    const committing = core.commit(write('b', 'two'))
    const answering = core.handleMessage((m) => frames.push(JSON.parse(m)), JSON.stringify({ snapshot: 'todos' }))
    await Promise.all([committing, answering])

    const seqs = frames.map((f) => Number(f.seq))
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    // the snapshot ran after the commit, so it carries that write's row and seq
    const snapshot = frames[frames.length - 1]
    expect(snapshot.reset).toBe(true)
    expect(snapshot.ops.map((op) => (op.value as any).id).sort()).toEqual(['a', 'b'])
    expect(Number(snapshot.seq)).toBe(Math.max(...seqs))
  })

  it('answers a constraint rejection 409, and stays serving after it', async () => {
    const { core } = await host()
    await core.commit(write('dup', 'first'))
    const res = await core.handleWrite(post(write('dup', 'second')))
    expect(res.status).toBe(409)
    const ok = await core.handleWrite(post(write('next', 'still serving')))
    expect(ok.status).toBe(200)
  })
})
