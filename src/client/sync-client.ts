// The transport-agnostic client engine. Owns ONE down-stream and a registry of
// collections, routes each incoming batch to its channel, and lets a writer
// await a specific seq's arrival (the settlement signal).

import type { SyncConfigRes } from '@tanstack/db'
import { applyBatch, dropUnsubscribed, type ChannelSink, type SliceApply } from './apply.ts'
import { ChannelSlices, sliceTargets } from './slices.ts'
import { SeqTracker, type CursorCompare } from './seq-tracker.ts'
import { ClosedError, type AuthError } from './errors.ts'
import { isSequencedBatch } from '../protocol.ts'
import type { Cursor, SequencedBatch, UpFrame, WriteAck, WriteBatch } from '../protocol.ts'

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
  // send one frame UP the down-stream's socket: a subscribe or an unsubscribe
  // (docs/architecture.md §8a, §18). The replies are ordinary batches on the
  // down-stream, so there is nothing to await here.
  //
  // The SyncClient sends `{ subscribe: channel }` when a collection registers a
  // SECOND time — TanStack DB dropped the first sink and its rows on GC, so
  // nothing but a fresh snapshot fills it (#47) — and a subscribe per slice for a
  // `sliceBy` collection.
  //
  // Implement it if you write your own transport. Without it a re-registered
  // collection still takes whatever streams in next, but nothing marks it READY
  // again — only a `ready` batch does that, and a delta isn't one — so it sits in
  // `loading` and `preload()` never resolves. A `sliceBy` collection refuses to
  // start without it.
  sendFrame?: (frame: UpFrame) => void
  // whether `sendFrame` would reach the room right now. The SyncClient sends a
  // subscribe only while this is true, and sends every live one again on
  // `onOpen`, so a frame is never queued behind a reconnect and sent twice.
  isOpen?: () => boolean
  // the down-stream (re)connected: a new socket, with no subscriptions on it yet.
  // Pass an `OpenEvent` to say why; a listener called with nothing treats it as an
  // ordinary reconnect. Returns an unsubscribe.
  onOpen?: (listener: (event?: OpenEvent) => void) => () => void
  // hang up the down-stream and dial again now. With `{ identityChanged: true }`,
  // drop the cursor and report the next open that way: the app's way to reload
  // under a new identity when the room won't close the socket for it.
  reconnect?: (opts?: OpenEvent) => void
}

// Why the down-stream opened, as far as the transport knows.
export type OpenEvent = {
  // What this user can read may have shrunk: the room closed the last socket
  // with `CLOSE_IDENTITY_CHANGED` (4001), or the app called `reconnect` with this
  // set. A transport that sets it must also have connected without `?since`, or
  // the non-sliced collections replay a delta and keep the rows the user lost.
  // A fresh connect for any other reason leaves it unset.
  identityChanged?: boolean
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
  // the `sliceBy` collections' subscriptions, by channel; set while registered.
  private slices = new Map<string, ChannelSlices>()
  // every channel declared `sliceBy`, registered or not. A batch for one with no
  // subscription is unwanted, and must not wait in `pending` for a register.
  private slicedChannels = new Set<string>()
  private pending = new Map<string, SequencedBatch[]>() // batches before register
  // channels that were registered and then torn down. A sink that comes back for
  // one of these is a fresh, EMPTY collection (TanStack GC dropped the rows), so
  // its register asks the server for a new snapshot — see `register`.
  private torndown = new Set<string>()
  // re-registered channels still waiting for their snapshot. A request made while
  // the socket is down goes nowhere, so each open asks again until it arrives.
  private awaitingSnapshot = new Set<string>()
  // settlement (the per-channel high-water mark + waiters + timeout) lives in a
  // pure SeqTracker, so it's testable without a transport and the timeout has a home.
  private tracker: SeqTracker
  private settleTimeoutMs: number
  private unsubscribe?: () => void
  private offOpen?: () => void
  // dropped on close: it is the closed flag, and letting it go releases the dead
  // socket. A collection outlives us holding the cleanup closure `register`
  // returns, so anything we still point at stays alive with it.
  private transport?: Transport

  constructor(transport: Transport, opts: SyncClientOptions = {}) {
    this.transport = transport
    this.tracker = new SeqTracker(opts.compareCursor)
    this.settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
    this.unsubscribe = transport.subscribe((batch) => this.route(batch))
    this.offOpen = transport.onOpen?.((event) => {
      for (const channel of this.awaitingSnapshot) this.sendFrame({ subscribe: channel })
      const fresh = event?.identityChanged === true
      for (const [channel, slices] of this.slices) {
        if (fresh) dropUnsubscribed(this.sinks.get(channel)!, slices)
        slices.resubscribe(fresh)
      }
    })
  }

  private sendFrame(frame: UpFrame) {
    if (this.transport?.isOpen?.() ?? true) this.transport?.sendFrame?.(frame)
  }

  private route(batch: SequencedBatch) {
    // a transport we don't own can hand us a frame with no channel: it would
    // buffer under `undefined` forever, so drop it.
    if (!isSequencedBatch(batch)) return
    const sink = this.sinks.get(batch.channel)
    // a sliced channel with no collection has no subscriptions to fill
    if (!sink && this.slicedChannels.has(batch.channel)) return
    if (!sink) {
      // a channel we tore down refills from the snapshot its next register asks
      // for, and that snapshot supersedes anything we could hold here — so don't
      // hold it. A transport that can't ask still needs the buffer: it is the
      // only refill that channel will get.
      if (this.torndown.has(batch.channel) && this.transport?.sendFrame) return
      const buffered = this.pending.get(batch.channel) ?? []
      buffered.push(batch)
      this.pending.set(batch.channel, buffered)
      return
    }
    this.apply(sink, batch)
  }

  private apply(sink: ChannelSink, batch: SequencedBatch) {
    const slices = this.slices.get(batch.channel)
    if (batch.reset && batch.ready) this.awaitingSnapshot.delete(batch.channel)
    const receipt = applyBatch(sink, batch, slices)
    slices?.applied(batch, receipt)
    this.tracker.observe(batch.channel, batch.seq)
  }

  // a collection's sync() hands us its callbacks under a channel name. The
  // returned cleanup is what TanStack DB calls when it garbage-collects the
  // collection; registering again after that is a new, empty sink.
  register(channel: string, sink: ChannelSink) {
    this.sinks.set(channel, sink)
    // a second register for this channel starts from nothing: the collection was
    // truncated with its old sink. Ask for a fresh snapshot; it arrives as a `reset`
    // batch and truncate-applies through the normal route, which is also what fires
    // `markReady` again. `route` buffered nothing for us in the meantime, so there
    // is nothing here that the snapshot would overwrite.
    if (this.torndown.delete(channel)) {
      this.awaitingSnapshot.add(channel)
      this.sendFrame({ subscribe: channel })
    }
    for (const batch of this.pending.get(channel) ?? []) this.apply(sink, batch)
    this.pending.delete(channel)
    return () => {
      // a cleanup that fires after this channel re-registered belongs to the OLD
      // sink: it must not unregister the live one.
      if (this.sinks.get(channel) !== sink) return
      this.sinks.delete(channel)
      this.awaitingSnapshot.delete(channel)
      this.torndown.add(channel)
    }
  }

  // Call before the collection's first sync, so the room's over-delivery for it is
  // dropped rather than buffered until a register that may never come.
  declareSliced(channel: string) {
    this.slicedChannels.add(channel)
  }

  // A `sliceBy` collection's sync: no rows until a live query asks for a slice.
  // Returns TanStack's sync result — `loadSubset` / `unloadSubset` turn each live
  // query's `where` into subscriptions (docs/architecture.md §18).
  registerSliced(
    channel: string,
    sink: ChannelSink,
    opts: { column: string; rows: SliceApply['rows'] },
  ): Required<Pick<SyncConfigRes, 'cleanup' | 'loadSubset' | 'unloadSubset'>> {
    if (!this.transport?.sendFrame) {
      throw new Error(`collection "${channel}" sets sliceBy, which needs a transport with sendFrame to subscribe to slices`)
    }
    this.slicedChannels.add(channel)
    const slices = new ChannelSlices(channel, opts.column, opts.rows, (frame) => this.sendFrame(frame), () => this.tracker.roomHigh())
    this.sinks.set(channel, sink)
    this.slices.set(channel, slices)
    sink.markReady()
    return {
      loadSubset: (options) => slices.acquire(sliceTargets(options.where, opts.column)),
      unloadSubset: (options) => slices.release(sliceTargets(options.where, opts.column)),
      cleanup: () => {
        if (this.sinks.get(channel) !== sink) return
        this.sinks.delete(channel)
        this.slices.delete(channel)
        slices.dispose()
      },
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

  // Redial the down-stream now (`Transport.reconnect`). Pass
  // `{ identityChanged: true }` after the app switches who is signed in.
  reconnect(opts?: OpenEvent) {
    if (!this.transport) throw new ClosedError()
    if (!this.transport.reconnect) throw new Error('this transport cannot reconnect on demand: it has no reconnect()')
    this.transport.reconnect(opts)
  }

  // One-way: a closed client never reopens, so build a new one.
  close() {
    if (!this.transport) return
    this.unsubscribe?.()
    this.unsubscribe = undefined // captures the socket handler — let it go too
    this.offOpen?.()
    this.offOpen = undefined
    this.tracker.rejectAll(new ClosedError())
    for (const slices of this.slices.values()) slices.dispose(new ClosedError())
    this.slices.clear()
    this.sinks.clear()
    this.pending.clear()
    this.torndown.clear()
    this.awaitingSnapshot.clear()
    this.transport.close?.()
    this.transport = undefined
  }
}
