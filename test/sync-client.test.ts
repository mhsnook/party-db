import { describe, it, expect, vi } from 'vitest'
import { SyncClient, type Transport } from '../src/client/sync-client.ts'
import type { ChannelSink } from '../src/client/apply.ts'
import type { SequencedBatch } from '../src/protocol.ts'

// A transport whose down-stream we drive by hand: `push` delivers a batch as if
// it had arrived on the wire.
function fakeTransport() {
  let onBatch: ((b: SequencedBatch) => void) | undefined
  const send = vi.fn(async () => ({ accepted: [] as { channel: string; seq: number }[] }))
  const transport: Transport = {
    subscribe(cb) {
      onBatch = cb
      return () => {
        onBatch = undefined
      }
    },
    send,
  }
  return {
    transport,
    send,
    push: (b: SequencedBatch) => onBatch?.(b),
  }
}

function recorder() {
  const ops: unknown[] = []
  const sink: ChannelSink = {
    begin: () => {},
    write: (op) => void ops.push(op.value),
    commit: () => {},
    markReady: () => {},
  }
  return { sink, ops }
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
    const client = new SyncClient(t.transport)
    client.register('todos', recorder().sink)
    client.register('lists', recorder().sink)
    t.push(seqBatch('todos', 9, { id: 'a' }))

    let listsSettled = false
    client.waitForSeq('lists', 2).then(() => (listsSettled = true))
    await Promise.resolve()
    expect(listsSettled).toBe(false) // todos' progress must not settle a lists write
  })

  it('treats a non-numeric (opaque) cursor as already settled', async () => {
    const t = fakeTransport()
    const client = new SyncClient(t.transport)
    await expect(client.waitForSeq('todos', 'lsn-0/16B3748')).resolves.toBeUndefined()
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
