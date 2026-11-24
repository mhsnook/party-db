import { describe, it, expect, vi } from 'vitest'
import { createCollection, createLiveQueryCollection, eq, type LoadSubsetOptions } from '@tanstack/db'
import { SyncClient, type OpenEvent } from '../src/client/sync-client.ts'
import type { SequencedBatch } from '../src/protocol.ts'
import { ChannelSlices, sliceTargets } from '../src/client/slices.ts'
import type { UpFrame } from '../src/protocol.ts'

// The IR a live query hands `loadSubset`, as plain data in the shape TanStack
// hands it: refs carry the column path with the alias already stripped. The
// end-to-end suite (test/integration/slices.test.ts) covers the query builder itself.
const ref = (path: string) => ({ type: 'ref', path: [path] })
class Value {
  type = 'val'
  constructor(public value: unknown) {}
}
class Func {
  type = 'func'
  constructor(
    public name: string,
    public args: unknown[],
  ) {}
}
const where = (expr: unknown) => expr as LoadSubsetOptions['where']

describe('sliceTargets reads the sliceBy equality out of a where', () => {
  const t = (expr: unknown) => sliceTargets(where(expr), 'thread_id')

  it('loads one slice for an equality, and several for inArray', () => {
    expect(t(new Func('eq', [ref('thread_id'), new Value('A')]))).toEqual(['A'])
    expect(t(new Func('in', [ref('thread_id'), new Value(['A', 'B', 'A'])]))).toEqual(['A', 'B'])
  })

  it('narrows through and, and unions through or', () => {
    expect(t(new Func('and', [new Func('eq', [ref('thread_id'), new Value('A')]), new Func('gt', [ref('n'), new Value(3)])]))).toEqual(['A'])
    expect(t(new Func('or', [new Func('eq', [ref('thread_id'), new Value('A')]), new Func('eq', [ref('thread_id'), new Value(7)])]))).toEqual(['A', 7])
  })

  it('loads the whole channel when nothing narrows it', () => {
    expect(t(undefined)).toEqual([null])
    expect(t(new Func('gt', [ref('n'), new Value(3)]))).toEqual([null])
    expect(t(new Func('eq', [ref('author'), new Value('A')]))).toEqual([null])
    expect(t(new Func('or', [new Func('eq', [ref('thread_id'), new Value('A')]), new Func('gt', [ref('n'), new Value(3)])]))).toEqual([null])
    expect(t(new Func('not', [new Func('eq', [ref('thread_id'), new Value('A')])]))).toEqual([null])
    expect(t(new Func('eq', [new Func('lower', [ref('thread_id')]), new Value('a')]))).toEqual([null])
  })

  it('loads nothing for an and that no slice can satisfy', () => {
    expect(t(new Func('and', [new Func('eq', [ref('thread_id'), new Value('A')]), new Func('eq', [ref('thread_id'), new Value('B')])]))).toEqual([])
  })
})

describe('ChannelSlices', () => {
  function slices() {
    const frames: UpFrame[] = []
    let seq: number | undefined
    const s = new ChannelSlices('comments', 'thread_id', () => [], (f) => void frames.push(f), () => seq)
    return { s, frames, setSeq: (n: number) => void (seq = n) }
  }
  const flush = () => new Promise<void>((r) => queueMicrotask(r))

  it('subscribes once per slice, however many queries want it', () => {
    const { s, frames } = slices()
    s.acquire(['A'])
    s.acquire(['A', 'B'])
    expect(frames).toEqual([
      { subscribe: 'comments', slice: 'A' },
      { subscribe: 'comments', slice: 'B' },
    ])
  })

  it('resolves a load once its ready reply has applied', async () => {
    const { s } = slices()
    const loaded = s.acquire(['A'])
    const done = vi.fn()
    ;(loaded as Promise<void>).then(done)
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, reset: true, slice: 'B' }, true)
    await flush()
    expect(done).not.toHaveBeenCalled()
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, reset: true, slice: 'A' }, true)
    await loaded
    expect(s.acquire(['A'])).toBe(true)
  })

  it('unsubscribes when the last query lets go, and resubscribes from that seq', async () => {
    const { s, frames, setSeq } = slices()
    s.acquire(['A'])
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, slice: 'A' }, true)
    s.acquire(['A'])
    s.release(['A'])
    await flush()
    expect(frames.at(-1)).toEqual({ subscribe: 'comments', slice: 'A' }) // still held once
    setSeq(9)
    s.release(['A'])
    await flush()
    expect(frames.at(-1)).toEqual({ unsubscribe: 'comments', slice: 'A' })
    expect(s.accepts({ thread_id: 'A' })).toBe(false)
    s.acquire(['A'])
    expect(frames.at(-1)).toEqual({ subscribe: 'comments', slice: 'A', since: 9 })
  })

  it('costs no round trip when a release and an acquire land in the same turn', async () => {
    const { s, frames } = slices()
    s.acquire(['A'])
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, slice: 'A' }, true)
    s.release(['A'])
    s.acquire(['A']) // TanStack's reload of a subset after a truncate
    await flush()
    expect(frames).toEqual([{ subscribe: 'comments', slice: 'A' }])
  })

  it('keeps the cursor of a slice released before its reply arrived', async () => {
    const { s, frames, setSeq } = slices()
    s.acquire(['A'])
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, slice: 'A' }, true)
    setSeq(9)
    s.release(['A'])
    await flush()
    s.acquire(['A']) // asks from 9
    s.release(['A']) // and leaves before the reply
    await flush()
    s.acquire(['A'])
    expect(frames.at(-1)).toEqual({ subscribe: 'comments', slice: 'A', since: 9 })
  })

  it('forgets released cursors when the whole channel resets', async () => {
    const { s, frames, setSeq } = slices()
    s.acquire(['A'])
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, slice: 'A' }, true)
    setSeq(5)
    s.release(['A'])
    await flush()
    s.applied({ channel: 'comments', seq: 8, ops: [], reset: true }, true)
    s.acquire(['A'])
    expect(frames.at(-1)).toEqual({ subscribe: 'comments', slice: 'A' })
  })

  it('asks again for every live subscription on a new socket', () => {
    const { s, frames, setSeq } = slices()
    s.acquire(['A'])
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, slice: 'A' }, true)
    s.acquire([null])
    setSeq(12)
    frames.length = 0
    s.resubscribe()
    expect(frames).toEqual([
      { subscribe: 'comments', slice: 'A', since: 12 },
      { subscribe: 'comments' },
    ])
  })

  it('asks every slice for a snapshot, and forgets released cursors, under a new identity', async () => {
    const { s, frames, setSeq } = slices()
    s.acquire(['A', 'B'])
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, slice: 'A' }, true)
    setSeq(7)
    s.release(['B'])
    await flush()
    s.acquire(['C']) // its reply has not arrived yet
    frames.length = 0
    s.resubscribe(true)
    expect(frames).toEqual([
      { subscribe: 'comments', slice: 'A' },
      { subscribe: 'comments', slice: 'C' },
    ])
    s.acquire(['B'])
    expect(frames.at(-1)).toEqual({ subscribe: 'comments', slice: 'B' })
  })

  it('makes a new query on a slice wait for its identity snapshot, not resolve on the old rows', async () => {
    const { s } = slices()
    s.acquire(['A'])
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, slice: 'A' }, true)
    expect(s.acquire(['A'])).toBe(true)
    s.resubscribe(true)
    const loaded = s.acquire(['A'])
    expect(loaded).toBeInstanceOf(Promise)
    const done = vi.fn()
    ;(loaded as Promise<void>).then(done)
    await flush()
    expect(done).not.toHaveBeenCalled()
    s.applied({ channel: 'comments', seq: 9, ops: [], ready: true, reset: true, slice: 'A' }, true)
    await loaded
  })

  it('keeps no cursor for a slice released while its identity snapshot is outstanding', async () => {
    const { s, frames, setSeq } = slices()
    s.acquire(['A'])
    s.applied({ channel: 'comments', seq: 3, ops: [], ready: true, slice: 'A' }, true)
    setSeq(7)
    s.release(['A']) // its unsubscribe waits a microtask
    s.resubscribe(true)
    await flush()
    s.acquire(['A'])
    expect(frames.at(-1)).toEqual({ subscribe: 'comments', slice: 'A' })
  })

  it('accepts a row of a subscribed slice, or any row while the whole channel is held', () => {
    const { s } = slices()
    s.acquire([7])
    expect(s.accepts({ thread_id: 7 })).toBe(true)
    expect(s.accepts({ thread_id: '7' })).toBe(true)
    expect(s.accepts({ thread_id: 8 })).toBe(false)
    s.acquire([null])
    expect(s.accepts({ thread_id: 8 })).toBe(true)
  })
})

// TanStack reloads every loaded subset after a truncate by unloading and loading
// it again. `release` waits a microtask so that pair costs no frames; this pins
// that TanStack's reload lands inside that microtask.
describe('a whole-channel reset on a real sliced collection', () => {
  it('sends no unsubscribe or subscribe for the slices it reloads', async () => {
    const frames: UpFrame[] = []
    let onBatch: (b: SequencedBatch) => void = () => {}
    const client = new SyncClient({
      subscribe: (l) => ((onBatch = l), () => {}),
      send: async () => ({ accepted: [] }),
      sendFrame: (f) => void frames.push(f),
    })
    const comments = createCollection<{ id: string; thread_id: string }>({
      id: 'comments-reset',
      getKey: (r) => r.id,
      syncMode: 'on-demand',
      sync: { sync: (params) => client.registerSliced('comments', params as never, { column: 'thread_id', rows: () => params.collection.entries() }) },
    })
    const threadA = createLiveQueryCollection((q) => q.from({ c: comments }).where(({ c }) => eq(c.thread_id, 'A')))
    const loaded = threadA.preload()
    onBatch({ channel: 'comments', seq: 1, ops: [{ type: 'insert', value: { id: 'a1', thread_id: 'A' } }], ready: true, reset: true, slice: 'A' })
    await loaded
    expect(frames).toEqual([{ subscribe: 'comments', slice: 'A' }])

    onBatch({ channel: 'comments', seq: 2, ops: [], ready: true, reset: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(frames).toEqual([{ subscribe: 'comments', slice: 'A' }])
  })
})

// #68: a socket the room closed for a changed identity reopens with no `?since`.
// A sliced collection has to reload its rows the same way, or the rows only the
// old identity could read stay in the collection.
describe('a sliced collection reopened under a new identity', () => {
  it('replaces each slice with its snapshot, and drops the rows of released slices', async () => {
    const frames: UpFrame[] = []
    let onBatch: (b: SequencedBatch) => void = () => {}
    let onOpen: (event?: OpenEvent) => void = () => {}
    const client = new SyncClient({
      subscribe: (l) => ((onBatch = l), () => {}),
      send: async () => ({ accepted: [] }),
      sendFrame: (f) => void frames.push(f),
      isOpen: () => true,
      onOpen: (l) => ((onOpen = l), () => {}),
    })
    const comments = createCollection<{ id: string; thread_id: string }>({
      id: 'comments-identity',
      getKey: (r) => r.id,
      syncMode: 'on-demand',
      sync: { sync: (params) => client.registerSliced('comments', params as never, { column: 'thread_id', rows: () => params.collection.entries() }) },
    })
    const threadA = createLiveQueryCollection((q) => q.from({ c: comments }).where(({ c }) => eq(c.thread_id, 'A')))
    const threadB = createLiveQueryCollection((q) => q.from({ c: comments }).where(({ c }) => eq(c.thread_id, 'B')))
    const loading = Promise.all([threadA.preload(), threadB.preload()])
    const ins = (id: string, thread_id: string) => ({ type: 'insert' as const, value: { id, thread_id } })
    onBatch({ channel: 'comments', seq: 2, ops: [ins('a1', 'A'), ins('a2', 'A')], ready: true, reset: true, slice: 'A' })
    onBatch({ channel: 'comments', seq: 2, ops: [ins('b1', 'B')], ready: true, reset: true, slice: 'B' })
    await loading
    await threadB.cleanup()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(comments.has('b1')).toBe(true) // a released slice keeps its rows

    frames.length = 0
    onOpen({ identityChanged: true })
    expect(frames).toEqual([{ subscribe: 'comments', slice: 'A' }])
    expect(comments.has('b1')).toBe(false)
    expect(comments.has('a2')).toBe(true) // held until its slice's snapshot replaces it

    onBatch({ channel: 'comments', seq: 5, ops: [ins('a1', 'A')], ready: true, reset: true, slice: 'A' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect([...comments.keys()]).toEqual(['a1'])
    expect(threadA.toArray.map((r) => r.id)).toEqual(['a1'])
  })
})
