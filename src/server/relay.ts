// TRUSTING MODE server: a dumb, channel-aware relay. Assigns per-channel seq,
// keeps a per-channel log for backlog replay, fans out. No validation, no
// server-side collection. This is the permissive pass-through.
//
// Written against partyserver's `Server`. Sketch — storage is in-memory here;
// back `logByChannel` with DO SQLite for durability (see controlled.ts).

import type { SequencedBatch, WriteBatch } from '../protocol.ts'

type Conn = { send: (data: string) => void }

export class RelayCore {
  private seqByChannel = new Map<string, number>()
  private logByChannel = new Map<string, SequencedBatch[]>()

  // replay every channel's backlog to a freshly connected client.
  onConnect(conn: Conn) {
    for (const [channel, log] of this.logByChannel) {
      for (const batch of log) conn.send(JSON.stringify(batch))
      conn.send(JSON.stringify({ channel, seq: this.seqByChannel.get(channel) ?? 0, ops: [], ready: true }))
    }
  }

  // accept (without validation), order, persist, and return the sequenced batch
  // for the caller to broadcast.
  accept(incoming: WriteBatch): SequencedBatch {
    const seq = (this.seqByChannel.get(incoming.channel) ?? 0) + 1
    this.seqByChannel.set(incoming.channel, seq)
    const batch: SequencedBatch = { channel: incoming.channel, ops: incoming.ops, seq }
    const log = this.logByChannel.get(incoming.channel) ?? []
    log.push(batch)
    this.logByChannel.set(incoming.channel, log)
    return batch
  }
}
