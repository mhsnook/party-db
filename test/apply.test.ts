import { describe, it, expect } from 'vitest'
import { applyBatch, type ChannelSink } from '../src/client/apply.ts'
import type { SequencedBatch, WriteEvent } from '../src/protocol.ts'

// A sink that records the call order so we can assert begin/write*/commit bracketing.
function recorder() {
  const calls: string[] = []
  const writes: WriteEvent[] = []
  const sink: ChannelSink = {
    begin: () => void calls.push('begin'),
    write: (op) => {
      calls.push('write')
      writes.push(op)
    },
    commit: () => void calls.push('commit'),
    markReady: () => void calls.push('markReady'),
  }
  return { sink, calls, writes }
}

const batch = (ops: WriteEvent[], extra: Partial<SequencedBatch> = {}): SequencedBatch => ({
  channel: 'todos',
  seq: 1,
  ops,
  ...extra,
})

describe('applyBatch', () => {
  it('brackets a multi-op batch in one begin()/commit() window, writing in order', () => {
    const { sink, calls, writes } = recorder()
    const ops: WriteEvent[] = [
      { type: 'insert', value: { id: 'a' } },
      { type: 'update', value: { id: 'b' }, previousValue: { id: 'b0' } },
    ]
    applyBatch(sink, batch(ops))
    expect(calls).toEqual(['begin', 'write', 'write', 'commit'])
    expect(writes).toEqual(ops)
  })

  it('skips begin/write/commit entirely for an empty batch', () => {
    const { sink, calls } = recorder()
    applyBatch(sink, batch([]))
    expect(calls).toEqual([])
  })

  it('calls markReady when the batch carries the ready sentinel', () => {
    const { sink, calls } = recorder()
    applyBatch(sink, batch([{ type: 'insert', value: { id: 'a' } }], { ready: true }))
    expect(calls).toEqual(['begin', 'write', 'commit', 'markReady'])
  })

  it('fires markReady alone for an empty ready batch (the snapshot-of-nothing case)', () => {
    const { sink, calls } = recorder()
    applyBatch(sink, batch([], { ready: true }))
    expect(calls).toEqual(['markReady'])
  })

  it('does not mark ready when the sentinel is absent', () => {
    const { sink, calls } = recorder()
    applyBatch(sink, batch([{ type: 'insert', value: { id: 'a' } }]))
    expect(calls).not.toContain('markReady')
  })
})
