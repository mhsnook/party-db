import { describe, it, expect } from 'vitest'
import type { WriteBatch, WriteReject } from '../../src/protocol.ts'
import { connect, post } from './helpers.ts'

// An update whose key matches no row is a REJECTION (409, `code: 'missing-row'`),
// not a silent success — the writer ruling on a row another client just deleted
// learns their write went nowhere, and no op for a row that doesn't exist reaches
// the `_oplog` or the subscribers (docs/architecture.md §16).
//
// Real workerd is where this has to be proven: on the DO's SqlStorageCursor,
// `one()` throws on zero rows, so the adapter reads the (possibly-empty)
// UPDATE … RETURNING result via toArray() and raises OUR verdict from the empty
// result — the engine itself never errors on an update that matches nothing.
describe('update of a nonexistent row is rejected on real workerd', () => {
  it('rejects 409 with code missing-row, and creates no row', async () => {
    const room = 'update-missing'
    const body: WriteBatch[] = [
      { channel: 'todos', ops: [{ type: 'update', value: { id: 'ghost', text: 'x' }, previousValue: { id: 'ghost' } }] },
    ]

    const res = await post(room, body)
    expect(res.status).toBe(409)
    const reject = (await res.json()) as WriteReject
    expect(reject.code).toBe('missing-row')
    expect(reject.channel).toBe('todos')
    expect(reject.error).toMatch(/update matched no row/)

    // a fresh client's snapshot must NOT contain a ghost row, and the rejected
    // write must have logged nothing: seq stays at 0
    const c = await connect(room)
    await c.waitFor(1)
    expect(c.batches[0]).toMatchObject({ channel: 'todos', ready: true, seq: 0 })
    expect(c.batches[0].ops).toHaveLength(0)
    c.ws.close()
  })

  it('an update writes only the columns it carries, leaving the rest alone', async () => {
    const room = 'update-partial'
    await post(room, [{ channel: 'todos', ops: [{ type: 'insert', value: { id: 't1', text: 'original' } }] }])
    // a writer that never read `text` sends only `done` — a stale copy of `text`
    // cannot travel, so it cannot revert anything
    const res = await post(room, [{ channel: 'todos', ops: [{ type: 'update', value: { id: 't1', done: true } }] }])
    expect(res.status).toBe(200)

    const c = await connect(room)
    await c.waitFor(1)
    expect(c.batches[0].ops[0].value).toMatchObject({ id: 't1', text: 'original', done: true })
    c.ws.close()
  })
})
