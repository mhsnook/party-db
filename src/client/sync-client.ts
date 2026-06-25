// The transport-agnostic client engine. Owns ONE down-stream and a registry of
// collections, routes each incoming batch to its channel, and lets a writer
// await a specific seq's arrival (the settlement signal).

import { applyBatch, type ChannelSink } from './apply.ts'
import type { Cursor, SequencedBatch, WriteAck, WriteBatch } from '../protocol.ts'

// A transport is just "a stream coming down" + "a way to push writes up".
// Today there is one impl (the DO/party transport); it stays an interface so the
// SyncClient never knows which target it's talking to.
export type Transport = {
  subscribe: (onBatch: (batch: SequencedBatch) => void) => () => void
  send: (batches: WriteBatch[]) => Promise<WriteAck>
  isConnecting?: () => boolean
}

type Waiter = { channel: string; seq: number; resolve: () => void }

export class SyncClient {
  private sinks = new Map<string, ChannelSink>()
  private pending = new Map<string, SequencedBatch[]>() // batches before register
  // highest seq applied per channel. seq is room-monotonic and arrives in order,
  // so a high-water mark is enough to settle writes — and it stays O(channels)
  // instead of growing with every write ever seen. (DO scope: seq is numeric.)
  private highest = new Map<string, number>()
  private waiters: Waiter[] = []
  private unsubscribe?: () => void

  constructor(private transport: Transport) {
    this.unsubscribe = transport.subscribe((batch) => this.route(batch))
  }

  private route(batch: SequencedBatch) {
    const sink = this.sinks.get(batch.channel)
    if (!sink) {
      const buffered = this.pending.get(batch.channel) ?? []
      buffered.push(batch)
      this.pending.set(batch.channel, buffered)
      return
    }
    this.apply(sink, batch)
  }

  private apply(sink: ChannelSink, batch: SequencedBatch) {
    applyBatch(sink, batch)
    if (typeof batch.seq !== 'number') return
    const prev = this.highest.get(batch.channel) ?? 0
    if (batch.seq > prev) this.highest.set(batch.channel, batch.seq)
    this.waiters = this.waiters.filter((w) => {
      if (w.channel === batch.channel && (this.highest.get(w.channel) ?? 0) >= w.seq) {
        w.resolve()
        return false
      }
      return true
    })
  }

  // a collection's sync() hands us its callbacks under a channel name.
  register(channel: string, sink: ChannelSink) {
    this.sinks.set(channel, sink)
    for (const batch of this.pending.get(channel) ?? []) this.apply(sink, batch)
    this.pending.delete(channel)
    return () => this.sinks.delete(channel)
  }

  // push a set of channel batches up in one shot; resolves with the ack
  // (carries each assigned seq). One batch for a single-collection write, many
  // for a cross-collection atomic transaction.
  send(batches: WriteBatch[]) {
    return this.transport.send(batches)
  }

  // resolve once `seq` has been applied on the down-stream. This is the
  // settlement signal: a write handler awaits this so the optimistic overlay
  // survives the ack->stream gap, then drops cleanly onto the synced row.
  waitForSeq(channel: string, seq: Cursor): Promise<void> {
    if (typeof seq !== 'number') return Promise.resolve()
    if ((this.highest.get(channel) ?? 0) >= seq) return Promise.resolve()
    return new Promise<void>((resolve) => this.waiters.push({ channel, seq, resolve }))
  }

  close() {
    this.unsubscribe?.()
  }
}
