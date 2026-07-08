import { describe, it, expect } from 'vitest'
import type { WriteBatch, WriteReject } from '../../src/protocol.ts'
import { insert, post } from './helpers.ts'

// The write-volume guards: a POST larger than `maxWriteBytes` or carrying more
// than `maxWriteOps` ops is refused with 413 before any DB work, and the room
// keeps serving normal writes afterwards. Both tests drive `Main`'s defaults
// (1 MiB / 1000 ops) rather than a bespoke low-limit DO class — the oversized
// request is rejected up front, so building it is the only cost.

describe('POST /write volume limits', () => {
  it('rejects a batch with more ops than maxWriteOps with 413, then keeps serving', async () => {
    const room = 'limit-ops'
    const many: WriteBatch[] = [
      { channel: 'todos', ops: Array.from({ length: 1001 }, (_, i) => ({ type: 'insert' as const, value: { id: `t${i}`, text: 'x' } })) },
    ]
    const res = await post(room, many)
    expect(res.status).toBe(413)
    const body = (await res.json()) as WriteReject
    expect(body.error).toMatch(/too many ops.*1000/)

    // the DO isn't wedged: an ordinary write still lands
    expect((await post(room, insert('ok', 'still works'))).status).toBe(200)
  })

  it('rejects a body larger than maxWriteBytes with 413, then keeps serving', async () => {
    const room = 'limit-bytes'
    const res = await post(room, insert('big', 'x'.repeat(1_100_000)))
    expect(res.status).toBe(413)
    const body = (await res.json()) as WriteReject
    expect(body.error).toMatch(/too large/)

    expect((await post(room, insert('ok', 'still works'))).status).toBe(200)
  })

  it('rejects a batch whose ops is not an array with 400', async () => {
    const res = await post('limit-shape', [{ channel: 'todos', ops: 'nope' }])
    expect(res.status).toBe(400)
    const body = (await res.json()) as WriteReject
    expect(body.error).toMatch(/ops must be an array/)
    expect(body.channel).toBe('todos')
  })
})
