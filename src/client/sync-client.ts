// The transport-agnostic client engine. Owns ONE down-stream and a registry of
// collections, routes each incoming batch to its channel, and lets a writer
// await a specific seq's arrival (the settlement signal).

import { applyBatch, type ChannelSink } from './apply.ts'
import { SeqTracker, type CursorCompare } from './seq-tracker.ts'
import type { Cursor, SequencedBatch, WriteAck, WriteBatch } from '../protocol.ts'

// A transport is just "a stream coming down" + "a way to push writes up".
// Today there is one impl (the DO/party transport); it stays an interface so the
// SyncClient never knows which target it's talking to.
export type Transport = {
  subscribe: (onBatch: (batch: SequencedBatch) => void) => () => void
  send: (batches: WriteBatch[]) => Promise<WriteAck>
  isConnecting?: () => boolean
}

export type SyncClientOptions = {
  // reject a `waitForSeq` that hasn't settled within this many ms (default 30000),
  // so a mutation can't hang forever if its seq never streams back. Pass `Infinity`
  // to wait indefinitely. A committed write is re-delivered on reconnect regardless.
  settleTimeoutMs?: number
  // override how cursors are compared (the seam for a v2 Postgres LSN).
  compareCursor?: CursorCompare
}

const DEFAULT_SETTLE_TIMEOUT_MS = 30_000

export class SyncClient {
  private sinks = new Map<string, ChannelSink>()
  private pending = new Map<string, SequencedBatch[]>() // batches before register
  // settlement (the per-channel high-water mark + waiters + timeout) lives in a
  // pure SeqTracker, so it's testable without a transport and the timeout has a home.
  private tracker: SeqTracker
  private settleTimeoutMs: number
  private unsubscribe?: () => void

  constructor(
    private transport: Transport,
    opts: SyncClientOptions = {},
  ) {
    this.tracker = new SeqTracker(opts.compareCursor)
    this.settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
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
    this.tracker.observe(batch.channel, batch.seq)
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
  // survives the ack->stream gap, then drops cleanly onto the synced row. Rejects
  // if it doesn't settle within the configured timeout (so the mutation can't hang).
  waitForSeq(channel: string, seq: Cursor): Promise<void> {
    return this.tracker.waitFor(channel, seq, this.settleTimeoutMs)
  }

  close() {
    this.unsubscribe?.()
    // nothing more will stream in — fail any in-flight waiters instead of hanging.
    this.tracker.rejectAll('sync client closed')
  }
}
