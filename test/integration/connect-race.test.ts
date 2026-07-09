import { describe, it, expect, vi } from 'vitest'
import type { SequencedBatch } from '../../src/protocol.ts'
import { connect, insert, post } from './helpers.ts'

// onConnect's snapshot READ and its SEND are serialized through the same queue as
// writes (party-db-server.ts). This test asserts the invariant that buys: a client
// accepted while writes are in flight never sees a batch whose seq goes backwards,
// and always ends up holding exactly the committed rows. Forcing the microtask
// interleaving from outside isn't reliable, so we fire concurrent connects + writes
// and assert per-client invariants; `repeats` re-runs it to shake out flakiness.

// Replay a client's received batches into final state. A `reset` (snapshot) batch
// clears first — so a row that appeared in an earlier broadcast and again in a
// later snapshot resolves to one entry, not a duplicate.
function reconstruct(batches: SequencedBatch[]) {
  const state = new Map<string, unknown>()
  for (const b of batches) {
    if (b.reset) state.clear()
    for (const op of b.ops) {
      const id = (op.value as { id: string }).id
      if (op.type === 'delete') state.delete(id)
      else state.set(id, op.value)
    }
  }
  return state
}

describe('concurrent connect + write: initial delivery is atomic w.r.t. writes', () => {
  it(
    'every connected client sees monotonic seqs and ends holding exactly w1..w3',
    { repeats: 10 },
    async () => {
      // a distinct room per repeat so each Durable Object starts empty (a reused
      // room would already hold w1..w3 and the writes would 409 on the dup PK)
      const room = `connect-race-${crypto.randomUUID()}`

      // fire three writes and two connects at the same room without awaiting between
      const results = await Promise.all([
        post(room, insert('w1', 'a')),
        connect(room),
        post(room, insert('w2', 'b')),
        connect(room),
        post(room, insert('w3', 'c')),
      ])
      const clients = [results[1], results[3]] as Array<Awaited<ReturnType<typeof connect>>>

      for (const c of clients) {
        // wait until this client has observed all three rows (via snapshot and/or
        // broadcasts), then assert the invariants on what it received.
        await vi.waitFor(() => {
          const state = reconstruct(c.batches)
          expect(state.has('w1') && state.has('w2') && state.has('w3')).toBe(true)
        })

        // monotonic delivery: seqs never decrease. Serialization guarantees no
        // batch older than the snapshot arrives after it.
        const seqs = c.batches.map((b) => Number(b.seq))
        expect(seqs).toEqual([...seqs].sort((p, q) => p - q))

        // no loss / no ghosts: final state is exactly the three committed rows
        expect(new Set(reconstruct(c.batches).keys())).toEqual(new Set(['w1', 'w2', 'w3']))

        c.ws.close()
      }
    },
  )
})
