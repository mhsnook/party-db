import { describe, it, expect, vi } from 'vitest'
import type { LoadSubsetOptions } from '@tanstack/db'
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
