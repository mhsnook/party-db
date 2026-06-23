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
// Wiring to a concrete server (partyserver `Server`) is left out; this captures
// the accept loop. Open questions live in unspecified.md.

import { applyBatch, type ChannelSink } from '../interpreter.ts'
import type { SequencedBatch, WriteAck, WriteBatch } from '../protocol.ts'

export type ServerCollection = {
  // the server-side sink — same four methods clients expose, but backed by
  // SQLite. A failing commit (constraint, schema) is how the server rejects.
  sink: ChannelSink
  // pull rows the commit resolved differently than submitted (db defaults,
  // server-assigned ids). Empty when client-minted UUIDs are authoritative.
  resolved?: (batch: SequencedBatch) => WriteBatch | undefined
}

export class ControlledCore {
  private seqByChannel = new Map<string, number>()

  constructor(
    private collections: Map<string, ServerCollection>,
    private broadcast: (batch: SequencedBatch) => void, // → all hibernating sockets
  ) {}

  // POST /write handler body. Accept-and-ack: apply to our own collection first.
  async write(body: WriteBatch[]): Promise<WriteAck> {
    const ack: WriteAck = { accepted: [], changed: [] }
    for (const incoming of body) {
      const target = this.collections.get(incoming.channel)
      if (!target) throw new Error(`unknown channel: ${incoming.channel}`)

      const seq = (this.seqByChannel.get(incoming.channel) ?? 0) + 1
      const batch: SequencedBatch = { channel: incoming.channel, ops: incoming.ops, seq }

      // apply to our SQLite-backed collection. If commit throws, the whole
      // POST fails and nothing is broadcast — the client's optimistic state
      // rolls back. (Whether a SQLite constraint the Zod schema missed actually
      // throws here is an open question — see unspecified.md.)
      applyBatch(target.sink, batch)

      this.seqByChannel.set(incoming.channel, seq)
      this.broadcast(batch) // fan out to every hibernating WS in the room
      ack.accepted.push({ channel: incoming.channel, seq })
      const changed = target.resolved?.(batch)
      if (changed) ack.changed!.push(changed)
    }
    return ack
  }
}
