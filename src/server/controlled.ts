// CONTROLLED MODE server, Durable Object flavor. SKETCH.
//
// The big idea: the server runs the SAME interpreter as clients, but its sink is
// a real TanStack DB collection backed by DO SQLite. "Apply the batch to my own
// collection; if the commit works, it's accepted" — that IS the accept-and-ack.
//
// Topology (optimised for DO + hibernation):
//   down  = hibernatable WebSockets (ctx.acceptWebSocket); cheap to hold open.
//   up    = POST /write; wakes the DO, runs accept-and-ack, broadcasts, replies.
//
// The seq is NOT free: we mint it, but the DO makes it cheap. Keep an append-only
//   _oplog(seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, op JSON)
// and, in ONE SQLite transaction per batch:
//   1. apply each op to the real table with RETURNING * -> the *resolved* row
//      (db defaults, generated columns, server ids)
//   2. insert the resolved op into _oplog -> AUTOINCREMENT assigns seq
//   3. COMMIT. a throw (constraint) fails the POST; nothing is broadcast.
// Because a DO is single-threaded + transactional, the _oplog rowid IS a total
// commit order. The resolved+sequenced batch is then broadcast AND acked.
//
// Wiring to a concrete server (partyserver `Server`) is left out. Open questions
// live in unspecified.md.

import type { SequencedBatch, WriteAck, WriteBatch } from '../protocol.ts'

export type ServerCollection = {
  // Apply a batch inside one storage transaction and return the resolved,
  // sequenced batch (ops carry post-commit values; seq from the _oplog rowid).
  // Throws on a failed commit — that rejection is how the server says "no".
  apply: (batch: WriteBatch) => SequencedBatch
}

export class ControlledCore {
  constructor(
    private collections: Map<string, ServerCollection>,
    private broadcast: (batch: SequencedBatch) => void, // -> all hibernating sockets
  ) {}

  // POST /write handler body. Accept-and-ack via our own storage-backed sink.
  // The stream carries the resolved rows; the ack just hands back the match
  // tokens (seq) so the caller can await settlement. `changed` is optional and
  // only filled for callers that want resolved rows without the stream.
  async write(body: WriteBatch[], opts?: { includeChanged?: boolean }): Promise<WriteAck> {
    const ack: WriteAck = { accepted: [] }
    for (const incoming of body) {
      const target = this.collections.get(incoming.channel)
      if (!target) throw new Error(`unknown channel: ${incoming.channel}`)

      // applies + sequences in one transaction; throws -> POST fails, client
      // rolls back its optimistic overlay, nothing broadcast.
      const resolved = target.apply(incoming)

      this.broadcast(resolved) // fan out the resolved row to the room
      ack.accepted.push({ channel: resolved.channel, seq: resolved.seq })
      if (opts?.includeChanged) (ack.changed ??= []).push(resolved)
    }
    return ack
  }
}
