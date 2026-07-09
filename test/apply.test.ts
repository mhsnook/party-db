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
    truncate: () => void calls.push('truncate'),
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

  it('truncates before applying a reset batch, inside the begin/commit window', () => {
    const { sink, calls, writes } = recorder()
    const ops: WriteEvent[] = [
      { type: 'insert', value: { id: 'a' } },
      { type: 'insert', value: { id: 'b' } },
    ]
    applyBatch(sink, batch(ops, { reset: true, ready: true }))
    // clear happens after begin and before any write, all in one commit window
    expect(calls).toEqual(['begin', 'truncate', 'write', 'write', 'commit', 'markReady'])
    expect(writes).toEqual(ops)
  })

  it('truncates even when a reset batch carries zero ops (the ghost-row cure)', () => {
    const { sink, calls } = recorder()
    applyBatch(sink, batch([], { reset: true, ready: true }))
    // an emptied room must still clear the client's prior rows
    expect(calls).toEqual(['begin', 'truncate', 'commit', 'markReady'])
  })

  it('never truncates a non-reset batch (regression guard)', () => {
    const { sink, calls } = recorder()
    applyBatch(sink, batch([{ type: 'insert', value: { id: 'a' } }], { ready: true }))
    expect(calls).not.toContain('truncate')
    expect(calls).toEqual(['begin', 'write', 'commit', 'markReady'])
  })
})
