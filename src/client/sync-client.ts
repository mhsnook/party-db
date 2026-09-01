// The transport-agnostic client engine. Owns ONE down-stream and a registry of
// collections, routes each incoming batch to its channel, and lets a writer
// await a specific seq's arrival (the settlement signal).

import { applyBatch, type ChannelSink } from './apply.ts'
import { SeqTracker, type CursorCompare } from './seq-tracker.ts'
import { ClosedError, type AuthError } from './errors.ts'
import { isSequencedBatch } from '../protocol.ts'
import type { Cursor, SequencedBatch, WriteAck, WriteBatch } from '../protocol.ts'

// A transport is just "a stream coming down" + "a way to push writes up".
// Today there is one impl (the DO/party transport); it stays an interface so the
// SyncClient never knows which target it's talking to.
export type Transport = {
  subscribe: (onBatch: (batch: SequencedBatch) => void) => () => void
  send: (batches: WriteBatch[]) => Promise<WriteAck>
  isConnecting?: () => boolean
  // we don't auto-reconnect when the down-stream is closed for auth (1008); this
  // hands that verdict to the app instead. Returns an unsubscribe.
  onAuthError?: (listener: (error: AuthError) => void) => () => void
  // hang up the down-stream, reconnect included. Optional like the two above:
  // `subscribe` + `send` is the whole seam, and everything else is a capability
  // a transport may not have.
  close?: () => void
  // ask the server to re-send one channel's current state. The SyncClient calls
  // this when a collection registers a SECOND time — TanStack DB dropped the
  // first sink and its rows on GC, so nothing but a fresh snapshot fills it
  // (#47). The reply is an ordinary `reset` batch on the down-stream, so there is
  // nothing to await here. A transport without the hook keeps the old behavior:
  // the re-registered collection fills on the next batch that streams in.
  requestSnapshot?: (channel: string) => void
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
  // channels that were registered and then torn down. A sink that comes back for
  // one of these is a fresh, EMPTY collection (TanStack GC dropped the rows), so
  // its register asks the server for a new snapshot — see `register`.
  private torndown = new Set<string>()
  // settlement (the per-channel high-water mark + waiters + timeout) lives in a
  // pure SeqTracker, so it's testable without a transport and the timeout has a home.
  private tracker: SeqTracker
  private settleTimeoutMs: number
  private unsubscribe?: () => void
  // dropped on close: it is the closed flag, and letting it go releases the dead
  // socket. A collection outlives us holding the cleanup closure `register`
  // returns, so anything we still point at stays alive with it.
  private transport?: Transport

  constructor(transport: Transport, opts: SyncClientOptions = {}) {
    this.transport = transport
    this.tracker = new SeqTracker(opts.compareCursor)
    this.settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
    this.unsubscribe = transport.subscribe((batch) => this.route(batch))
  }

  private route(batch: SequencedBatch) {
    // a transport we don't own can hand us a frame with no channel: it would
    // buffer under `undefined` forever, so drop it.
    if (!isSequencedBatch(batch)) return
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

  // a collection's sync() hands us its callbacks under a channel name. The
  // returned cleanup is what TanStack DB calls when it garbage-collects the
  // collection; registering again after that is a new, empty sink.
  register(channel: string, sink: ChannelSink) {
    this.sinks.set(channel, sink)
    // a second register for this channel starts from nothing: the buffered
    // batches are long gone and the collection was truncated with its old sink.
    // Ask for a fresh snapshot; it arrives as a `reset` batch and truncate-applies
    // through the normal route, which is also what fires `markReady` again.
    if (this.torndown.delete(channel)) this.transport?.requestSnapshot?.(channel)
    for (const batch of this.pending.get(channel) ?? []) this.apply(sink, batch)
    this.pending.delete(channel)
    return () => {
      // a cleanup that fires after this channel re-registered belongs to the OLD
      // sink: it must not unregister the live one.
      if (this.sinks.get(channel) !== sink) return
      this.sinks.delete(channel)
      this.torndown.add(channel)
    }
  }

  // push a set of channel batches up in one shot; resolves with the ack
  // (carries each assigned seq). One batch for a single-collection write, many
  // for a cross-collection atomic transaction.
  send(batches: WriteBatch[]) {
    // a closed client has no down-stream, so the seq this write earns could never
    // arrive: fail now rather than POST and time out 30s from now.
    if (!this.transport) return Promise.reject(new ClosedError())
    return this.transport.send(batches)
  }

  // resolve once `seq` has been applied on the down-stream. This is the
  // settlement signal: a write handler awaits this so the optimistic overlay
  // survives the ack->stream gap, then drops cleanly onto the synced row. Rejects
  // if it doesn't settle within the configured timeout (so the mutation can't hang).
  waitForSeq(channel: string, seq: Cursor): Promise<void> {
    if (!this.transport) return Promise.reject(new ClosedError())
    return this.tracker.waitFor(channel, seq, this.settleTimeoutMs)
  }

  // One-way: a closed client never reopens, so build a new one.
  close() {
    if (!this.transport) return
    this.unsubscribe?.()
    this.unsubscribe = undefined // captures the socket handler — let it go too
    this.tracker.rejectAll(new ClosedError())
    this.sinks.clear()
    this.pending.clear()
    this.torndown.clear()
    this.transport.close?.()
    this.transport = undefined
  }
}
