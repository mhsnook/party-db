// The transport-agnostic client engine. Owns ONE down-stream and a registry of
// collections, and routes each incoming batch to the right channel. This is the
// primitive the DX wraps — keep it boring and stable.

import { applyBatch, type ChannelSink } from '../interpreter.ts'
import type { SequencedBatch, WriteBatch, WriteAck } from '../protocol.ts'

// A transport is just "a stream coming down" + "a way to push writes up".
// Swapping DO/WebSocket for PostgREST/SSE is swapping this and nothing else.
export type Transport = {
  // subscribe to the down-stream (WS or SSE). Returns an unsubscribe.
  subscribe: (onBatch: (batch: SequencedBatch) => void) => () => void
  // push a batch up. controlled mode resolves with the ack; trusting mode may
  // resolve immediately (fire-and-forget, possibly over the same socket).
  send: (batch: WriteBatch) => Promise<WriteAck | void>
}

export class SyncClient {
  private sinks = new Map<string, ChannelSink>()
  // batches that arrive before their collection has registered (lazy mounts).
  private pending = new Map<string, SequencedBatch[]>()
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
    applyBatch(sink, batch)
  }

  // a collection's sync() hands us its callbacks under a channel name.
  register(channel: string, sink: ChannelSink) {
    this.sinks.set(channel, sink)
    for (const batch of this.pending.get(channel) ?? []) applyBatch(sink, batch)
    this.pending.delete(channel)
    return () => this.sinks.delete(channel)
  }

  // used by collection handlers (onInsert/onUpdate/onDelete) to push directives up.
  send(channel: string, ops: WriteBatch['ops']) {
    return this.transport.send({ channel, ops })
  }

  close() {
    this.unsubscribe?.()
  }
}
