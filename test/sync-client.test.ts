import { describe, it, expect, vi } from 'vitest'
import { SyncClient, type Transport } from '../src/client/sync-client.ts'
import { ClosedError } from '../src/client/errors.ts'
import type { ChannelSink } from '../src/client/apply.ts'
import type { SequencedBatch } from '../src/protocol.ts'

// A transport whose down-stream we drive by hand: `push` delivers a batch as if
// it had arrived on the wire.
function fakeTransport() {
  let onBatch: ((b: SequencedBatch) => void) | undefined
  const send = vi.fn(async () => ({ accepted: [] as { channel: string; seq: number }[] }))
  const close = vi.fn()
  const requestSnapshot = vi.fn()
  const transport: Transport = {
    subscribe(cb) {
      onBatch = cb
      return () => {
        onBatch = undefined
      }
    },
    send,
    close,
    requestSnapshot,
  }
  return {
    transport,
    send,
    close,
    requestSnapshot,
    push: (b: SequencedBatch) => onBatch?.(b),
  }
}

function recorder() {
  const ops: unknown[] = []
  const markReady = vi.fn()
  const truncate = vi.fn()
  const sink: ChannelSink = {
    begin: () => {},
    write: (op) => void ops.push(op.value),
    commit: () => {},
    markReady,
    truncate,
  }
  return { sink, ops, markReady, truncate }
}

const seqBatch = (channel: string, seq: number, value: unknown): SequencedBatch => ({
  channel,
  seq,
  ops: [{ type: 'insert', value: value as Record<string, unknown> }],
})

describe('SyncClient routing', () => {
  it('routes an incoming batch to the registered channel sink', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    const { sink, ops } = recorder()
    client.register('todos', sink)

    t.push(seqBatch('todos', 1, { id: 'a' }))
    expect(ops).toEqual([{ id: 'a' }])
  })

  it('ignores a batch for a channel with no sink (no throw), then never misroutes it', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    const { sink, ops } = recorder()
    client.register('todos', sink)

    expect(() => t.push(seqBatch('lists', 1, { id: 'x' }))).not.toThrow()
    expect(ops).toEqual([])
  })
})

describe('SyncClient pending buffer', () => {
  it('buffers batches that arrive before register, then flushes them in order on register', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)

    t.push(seqBatch('todos', 1, { id: 'a' }))
    t.push(seqBatch('todos', 2, { id: 'b' }))

    const { sink, ops } = recorder()
    client.register('todos', sink)
    expect(ops).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('drains the pending buffer so a re-register does not replay it', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    t.push(seqBatch('todos', 1, { id: 'a' }))

    const first = recorder()
    client.register('todos', first.sink)()  // register returns an unsubscribe; call it
    const second = recorder()
    client.register('todos', second.sink)
    expect(first.ops).toEqual([{ id: 'a' }])
    expect(second.ops).toEqual([]) // buffer already consumed by the first register
  })
})

describe('SyncClient drops frames that are not batches (issue #48)', () => {
  it('never buffers a frame with no channel, and keeps routing real ones', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)

    // a composed host sharing the socket can hand us frames of its own
    const foreign = [{ type: 'cf_agent_stream', id: 'x' }, { seq: 9, ops: [] }, { channel: 'todos', seq: 9 }, null]
    for (const frame of foreign) {
      expect(() => t.push(frame as unknown as SequencedBatch)).not.toThrow()
    }

    // nothing was buffered: registering later replays only real batches
    const { sink, ops } = recorder()
    client.register('todos', sink)
    expect(ops).toEqual([])

    t.push(seqBatch('todos', 1, { id: 'a' }))
    expect(ops).toEqual([{ id: 'a' }])
  })
})

describe('SyncClient waitForSeq settlement', () => {
  it('resolves once the awaited seq is applied on the stream', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)

    let settled = false
    const p = client.waitForSeq('todos', 3).then(() => (settled = true))
    expect(settled).toBe(false)

    t.push(seqBatch('todos', 3, { id: 'a' }))
    await p
    expect(settled).toBe(true)
  })

  it('resolves immediately when the high-water mark already passed the seq', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)
    t.push(seqBatch('todos', 5, { id: 'a' }))

    await expect(client.waitForSeq('todos', 3)).resolves.toBeUndefined()
  })

  it('resolves a waiter whose seq sits between applied seqs (high-water, not equality)', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)

    const p = client.waitForSeq('todos', 4)
    t.push(seqBatch('todos', 5, { id: 'a' })) // jumps past 4
    await expect(p).resolves.toBeUndefined()
  })

  it('keeps the high-water mark monotonic when a lower seq arrives late', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)
    t.push(seqBatch('todos', 5, { id: 'a' }))
    t.push(seqBatch('todos', 3, { id: 'b' })) // out-of-order straggler, must not lower the mark

    await expect(client.waitForSeq('todos', 5)).resolves.toBeUndefined()
  })

  it('tracks the high-water mark per channel independently', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport, { settleTimeoutMs: Infinity })
    client.register('todos', recorder().sink)
    client.register('lists', recorder().sink)
    t.push(seqBatch('todos', 9, { id: 'a' }))

    let listsSettled = false
    client.waitForSeq('lists', 2).then(() => (listsSettled = true))
    await Promise.resolve()
    expect(listsSettled).toBe(false) // todos' progress must not settle a lists write
  })

  it('tracks string (opaque) cursors instead of treating them as pre-settled', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)

    let settled = false
    const p = client.waitForSeq('todos', 'lsn-b').then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false) // not auto-resolved just because it's a string

    t.push({ channel: 'todos', seq: 'lsn-b', ops: [{ type: 'insert', value: { id: 'x' } }] })
    await p
    expect(settled).toBe(true)
  })
})

describe('SyncClient send + close', () => {
  it('forwards batches to the transport and returns the ack', async () => {
    const t = fakeTransport()
    t.send.mockResolvedValueOnce({ accepted: [{ channel: 'todos', seq: 1 }] })
    const client = new SyncClient(t.transport)

    const ack = await client.send([{ channel: 'todos', ops: [{ type: 'insert', value: { id: 'a' } }] }])
    expect(t.send).toHaveBeenCalledOnce()
    expect(ack.accepted).toEqual([{ channel: 'todos', seq: 1 }])
  })

  it('closes the transport once, however many times it is closed', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.close()
    client.close()
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('closes a transport that has no close of its own', () => {
    const { close, ...noClose } = fakeTransport().transport as Required<Transport>
    expect(() => new SyncClient(noClose).close()).not.toThrow()
  })

  it('rejects a send after close with a ClosedError, without hitting the transport', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.close()

    await expect(client.send([{ channel: 'todos', ops: [] }])).rejects.toBeInstanceOf(ClosedError)
    expect(t.send).not.toHaveBeenCalled()
  })

  it('rejects a waitForSeq after close instead of waiting out the settle timeout', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.close()

    await expect(client.waitForSeq('todos', 1)).rejects.toBeInstanceOf(ClosedError)
  })

  it('rejects a waiter that was already in flight with the same ClosedError', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    const pending = client.waitForSeq('todos', 1)
    client.close()

    // one cause, one class — however the write was timed against the close
    await expect(pending).rejects.toBeInstanceOf(ClosedError)
  })

  it('unsubscribes from the transport on close', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)
    client.close()

    const { sink, ops } = recorder()
    client.register('todos', sink)
    t.push(seqBatch('todos', 1, { id: 'a' }))
    expect(ops).toEqual([]) // stream detached, nothing routed
  })
})

// The re-register path: TanStack DB garbage-collects a collection when its last
// subscriber leaves, then restarts sync on the next access — a second `register`
// against an EMPTY collection. Nothing replays it, so the client asks the server
// for a fresh snapshot (issue #47).
describe('SyncClient re-register asks for a snapshot', () => {
  it('asks for nothing on a first register', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)
    expect(t.requestSnapshot).not.toHaveBeenCalled()
  })

  it('asks exactly once when a torn-down channel registers again', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)()
    client.register('todos', recorder().sink)

    expect(t.requestSnapshot).toHaveBeenCalledTimes(1)
    expect(t.requestSnapshot).toHaveBeenCalledWith('todos')
  })

  it('replays the reset snapshot into the fresh sink, truncate and ready included', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    const first = recorder()
    client.register('todos', first.sink)()

    const second = recorder()
    client.register('todos', second.sink)
    t.push({ channel: 'todos', seq: 4, ops: [{ type: 'insert', value: { id: 'a' } }], ready: true, reset: true })

    expect(second.ops).toEqual([{ id: 'a' }])
    expect(second.truncate).toHaveBeenCalledTimes(1)
    expect(second.markReady).toHaveBeenCalledTimes(1)
    // the reply is for the sink that asked: the collection GC dropped never sees it
    expect(first.ops).toEqual([])
  })

  it('drops what buffered while the sink was gone: the snapshot carries it', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)()
    t.push(seqBatch('todos', 2, { id: 'b' })) // streamed in with no sink to take it

    const second = recorder()
    client.register('todos', second.sink)
    expect(second.ops).toEqual([]) // not written, then truncated away microseconds later

    // the requested snapshot is what fills it, and it carries that row
    t.push({ channel: 'todos', seq: 2, ops: [{ type: 'insert', value: { id: 'b' } }], ready: true, reset: true })
    expect(second.ops).toEqual([{ id: 'b' }])
  })

  it('still replays the buffer for a transport that cannot ask', () => {
    const t = fakeTransport()
    const { requestSnapshot, ...bare } = t.transport
    const client = new SyncClient(bare)
    client.register('todos', recorder().sink)()
    t.push(seqBatch('todos', 2, { id: 'b' }))

    const second = recorder()
    client.register('todos', second.sink)
    expect(second.ops).toEqual([{ id: 'b' }]) // the only fill it will get
  })

  it('asks again on each later teardown, and never for a channel still registered', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    const cleanup = client.register('todos', recorder().sink)
    cleanup()
    cleanup() // idempotent: a second call is not a second teardown
    client.register('todos', recorder().sink)()
    client.register('todos', recorder().sink)
    expect(t.requestSnapshot.mock.calls).toEqual([['todos'], ['todos']])
  })

  it("keeps the old behavior for a transport that can't request one", () => {
    const t = fakeTransport()
    const { requestSnapshot, ...bare } = t.transport
    const client = new SyncClient(bare)
    const { sink, ops } = recorder()
    client.register('todos', recorder().sink)()
    client.register('todos', sink)

    // still fed by whatever streams in next
    t.push(seqBatch('todos', 1, { id: 'a' }))
    expect(ops).toEqual([{ id: 'a' }])
  })

  it('lets a stale cleanup fire without unregistering the live sink', () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    const staleCleanup = client.register('todos', recorder().sink)
    const live = recorder()
    client.register('todos', live.sink) // TanStack re-synced before the old cleanup ran
    staleCleanup()

    t.push(seqBatch('todos', 1, { id: 'a' }))
    expect(live.ops).toEqual([{ id: 'a' }])
  })
})
