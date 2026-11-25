import { describe, it, expect, vi } from 'vitest'
import { createLiveQueryCollection, eq } from '@tanstack/db'
import { createPartyDb, definePartyCollection } from '../src/client/index.ts'
import { ClosedError, DroppedError } from '../src/client/errors.ts'
import type { ResetReason, Transport } from '../src/client/sync-client.ts'
import type { SequencedBatch, UpFrame, WriteAck, WriteBatch } from '../src/protocol.ts'

// A transport the test drives by hand: `deliver` a frame, `open` a socket,
// `close` one with a code. Every write waits until the test answers it.
function hand() {
  let onBatch: (b: SequencedBatch) => void = () => {}
  let since: () => unknown = () => undefined
  let open = true
  const openers = new Set<() => void>()
  const closers = new Set<(code: number) => void>()
  const frames: UpFrame[] = []
  const writes: { batches: WriteBatch[]; answer: (ack: WriteAck) => void }[] = []
  const reconnect = vi.fn(() => {
    open = false
    closers.forEach((l) => l(1000))
  })
  const transport: Transport = {
    subscribe: (cb, opts) => ((onBatch = cb), (since = opts?.since ?? since), () => {}),
    send: (batches) => new Promise((answer) => writes.push({ batches, answer })),
    sendFrame: (f) => void frames.push(f),
    isOpen: () => open,
    onOpen: (l) => (openers.add(l), () => openers.delete(l)),
    onClose: (l) => (closers.add(l), () => closers.delete(l)),
    reconnect,
    close: () => {},
  }
  return {
    transport,
    frames,
    writes,
    reconnect,
    since: () => since(),
    deliver: (b: SequencedBatch) => onBatch(b),
    open: () => ((open = true), openers.forEach((l) => l())),
    close: (code: number) => ((open = false), closers.forEach((l) => l(code))),
  }
}

type Row = { id: string; thread_id?: string }
// 'authed' reads depend on who is asking, so a reset replaces these two
const todos = definePartyCollection<Row, 'todos'>({ name: 'todos', key: 'id', access: 'authed' })
const comments = definePartyCollection<Row, 'comments'>({ name: 'comments', key: 'id', sliceBy: 'thread_id', access: 'authed' })
const catalog = definePartyCollection<Row, 'catalog'>({ name: 'catalog', key: 'id', access: { read: 'public', insert: 'authed' } })
const snapshot = (channel: string, seq: number, ids: string[], extra: Partial<SequencedBatch> = {}): SequencedBatch => ({
  channel,
  seq,
  ops: ids.map((id) => ({ type: 'insert', value: { id, thread_id: 'A' } })),
  ready: true,
  reset: true,
  ...extra,
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

async function loaded() {
  const t = hand()
  const party = createPartyDb(t.transport, [todos, comments])
  const reasons: ResetReason[] = []
  party.onReset((reason) => reasons.push(reason))
  const ready = party.db.todos.preload()
  t.deliver(snapshot('todos', 3, ['a1', 'a2']))
  await ready
  return { t, party, reasons }
}

describe('reset()', () => {
  it('replaces every collection with a fresh one that loads, and empties the old', async () => {
    const { t, party, reasons } = await loaded()
    const old = party.db.todos
    const oldQuery = createLiveQueryCollection((q) => q.from({ t: old }))
    await oldQuery.preload()

    party.reset()
    expect(reasons).toEqual(['requested'])
    expect(t.reconnect).toHaveBeenCalledTimes(1)
    expect(party.db.todos).not.toBe(old)
    expect(old.size).toBe(0)
    await tick()
    expect(oldQuery.toArray).toEqual([]) // a query nobody rebuilt shows empty, never the old rows

    const fresh = party.db.todos.preload()
    expect(party.db.todos.status).toBe('loading')
    t.open()
    t.deliver(snapshot('todos', 9, ['b1']))
    await fresh
    expect(party.db.todos.status).toBe('ready')
    expect([...party.db.todos.keys()]).toEqual(['b1'])
  })

  it('redials with no cursor, and ignores the old socket until the next one opens', async () => {
    const { t, party } = await loaded()
    expect(t.since()).toBe(3)
    party.reset()
    expect(t.since()).toBeUndefined()

    void party.db.todos.preload()
    t.deliver(snapshot('todos', 4, ['stale'])) // the old socket, before it closed
    expect(t.since()).toBeUndefined()
    expect(t.frames).toEqual([]) // no subscribe goes up the old socket

    t.open()
    expect(t.frames).toEqual([{ subscribe: 'todos' }])
    t.deliver(snapshot('todos', 9, ['b1']))
    await party.db.todos.preload()
    expect([...party.db.todos.keys()]).toEqual(['b1'])
  })

  it('rolls back a write in flight across it, and refuses a write to an old collection', async () => {
    const { t, party } = await loaded()
    const old = party.db.todos
    const inFlight = old.insert({ id: 'pending' })
    expect(old.has('pending')).toBe(true)

    party.reset()
    t.writes[0].answer({ accepted: [{ channel: 'todos', seq: 4 }] })
    await expect(inFlight.isPersisted.promise).rejects.toBeInstanceOf(DroppedError)
    expect(old.has('pending')).toBe(false)

    const late = old.insert({ id: 'late' })
    await expect(late.isPersisted.promise).rejects.toBeInstanceOf(DroppedError)
    expect(t.writes).toHaveLength(1) // the late write never reached the room
  })

  it('rejects a write that was waiting for its seq', async () => {
    const { t, party } = await loaded()
    const waiting = party.db.todos.insert({ id: 'pending' })
    t.writes[0].answer({ accepted: [{ channel: 'todos', seq: 4 }] })
    await tick() // the ack landed; the write now waits for seq 4 on the stream
    party.reset()
    await expect(waiting.isPersisted.promise).rejects.toBeInstanceOf(DroppedError)
  })

  it('throws before touching anything on a transport that cannot reconnect, and on a closed client', async () => {
    const t = hand()
    const { reconnect, ...bare } = t.transport
    const party = createPartyDb(bare, [todos])
    const before = party.db.todos
    expect(() => party.reset()).toThrow(/cannot reconnect|no reconnect/)
    expect(party.db.todos).toBe(before)

    const closing = createPartyDb(hand().transport, [todos])
    closing.close()
    expect(() => closing.reset()).toThrow(ClosedError)
  })

  it('keeps a collection everyone reads the same, and refills it in place from the next snapshot', async () => {
    const t = hand()
    const party = createPartyDb(t.transport, [todos, catalog])
    const ready = Promise.all([party.db.todos.preload(), party.db.catalog.preload()])
    t.deliver(snapshot('todos', 3, ['a1']))
    t.deliver(snapshot('catalog', 3, ['p1', 'p2']))
    await ready
    const [oldTodos, oldCatalog] = [party.db.todos, party.db.catalog]

    party.reset()
    expect(party.db.todos).not.toBe(oldTodos)
    expect(party.db.catalog).toBe(oldCatalog)
    expect([...oldCatalog.keys()]).toEqual(['p1', 'p2']) // still on screen while the socket redials
    expect(t.since()).toBeUndefined()

    t.open()
    t.deliver(snapshot('catalog', 6, ['p2', 'p3']))
    expect([...oldCatalog.keys()]).toEqual(['p2', 'p3'])
  })

  it('keeps the rows a public `snapshot: false` collection tailed, though the room answers the redial with an empty reset', async () => {
    const t = hand()
    const feed = definePartyCollection<Row, 'feed'>({ name: 'feed', key: 'id', snapshot: false })
    const party = createPartyDb(t.transport, [feed])
    const ready = party.db.feed.preload()
    t.deliver(snapshot('feed', 3, []))
    await ready
    t.deliver({ channel: 'feed', seq: 4, ops: [{ type: 'insert', value: { id: 'f1' } }] })

    party.reset()
    t.open()
    t.deliver(snapshot('feed', 9, []))
    expect([...party.db.feed.keys()]).toEqual(['f1'])
  })

  it('still redials when an onReset listener throws, and calls the listeners after it', async () => {
    const { t, party, reasons } = await loaded()
    const later = vi.fn()
    party.onReset(() => {
      throw new Error('rebuild failed')
    })
    party.onReset(later)
    expect(() => party.reset()).toThrow('rebuild failed')
    expect(reasons).toEqual(['requested'])
    expect(later).toHaveBeenCalledTimes(1)
    expect(t.reconnect).toHaveBeenCalledTimes(1)
  })

  it('refuses a reset() called from an onReset listener, instead of recursing', async () => {
    const { t, party } = await loaded()
    party.onReset(() => party.reset())
    expect(() => party.reset()).toThrow(/already running/)
    expect(t.reconnect).toHaveBeenCalledTimes(1)
  })
})

describe('a changed-identity close (4001)', () => {
  it('resets without being asked, and leaves the redial to the transport', async () => {
    const { t, party, reasons } = await loaded()
    const old = party.db.todos
    t.close(4001)
    expect(reasons).toEqual(['identity-changed'])
    expect(t.reconnect).not.toHaveBeenCalled()
    expect(old.size).toBe(0)
    expect(party.db.todos).not.toBe(old)
    expect(t.since()).toBeUndefined()
  })

  it('leaves an ordinary drop alone', async () => {
    const { t, party, reasons } = await loaded()
    const old = party.db.todos
    t.close(1006)
    expect(reasons).toEqual([])
    expect(party.db.todos).toBe(old)
    expect(t.since()).toBe(3)
  })
})

describe('reset() on a sliced collection', () => {
  it('gives a fresh collection whose queries subscribe on the next socket, with no cursor', async () => {
    const { t, party } = await loaded()
    const oldThread = createLiveQueryCollection((q) => q.from({ c: party.db.comments }).where(({ c }) => eq(c.thread_id, 'A')))
    const oldLoad = oldThread.preload()
    t.deliver(snapshot('comments', 5, ['c1'], { slice: 'A' }))
    await oldLoad
    expect(oldThread.toArray.map((r) => r.id)).toEqual(['c1'])
    t.frames.length = 0

    party.reset()
    await tick()
    expect(oldThread.toArray).toEqual([])

    const thread = createLiveQueryCollection((q) => q.from({ c: party.db.comments }).where(({ c }) => eq(c.thread_id, 'A')))
    const load = thread.preload()
    await tick()
    expect(t.frames).toEqual([]) // held until the new socket opens
    t.open()
    expect(t.frames).toEqual([{ subscribe: 'comments', slice: 'A' }])
    t.deliver(snapshot('comments', 9, ['c2'], { slice: 'A' }))
    await load
    expect(thread.toArray.map((r) => r.id)).toEqual(['c2'])
  })
})
