import { describe, it, expect } from 'vitest'
import type { WriteAck, WriteBatch } from '../../src/protocol.ts'
import { connect, post } from './helpers.ts'

// An update of a row that doesn't exist is a documented no-op that echoes the sent
// value — NOT an error. On the real DO SqlStorageCursor, `one()` throws on zero
// rows, so the adapter must read the (possibly-empty) UPDATE … RETURNING result via
// toArray(); otherwise a client updating a row another client just deleted would get
// a 409 that rolls its whole optimistic transaction back. This exercises that path
// on real workerd (the unit suite only reaches the node:sqlite shim).
describe('update of a nonexistent row is a no-op on real workerd', () => {
  it('acks 200 with the sent value and creates no row', async () => {
    const room = 'update-missing'
    const body: WriteBatch[] = [
      { channel: 'todos', ops: [{ type: 'update', value: { id: 'ghost', text: 'x' }, previousValue: { id: 'ghost' } }] },
    ]

    const res = await post(room, body)
    expect(res.status).toBe(200) // not 409
    const ack = (await res.json()) as WriteAck
    // the ack carries the sent value back unchanged — nothing was resolved from the DB
    expect(ack.changed?.[0].ops[0]).toEqual({
      type: 'update',
      value: { id: 'ghost', text: 'x' },
      previousValue: { id: 'ghost' },
    })

    // a fresh client's snapshot must NOT contain a ghost row — the no-op created nothing
    const c = await connect(room)
    await c.waitFor(1)
    expect(c.batches[0]).toMatchObject({ channel: 'todos', ready: true })
    expect(c.batches[0].ops).toHaveLength(0)
    c.ws.close()
  })
})
