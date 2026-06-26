// Settlement, pulled out of SyncClient so it's a pure unit (no transport) and so
// the "what if the seq never streams back" case has a home: a timeout that
// rejects, instead of a promise that hangs forever.
//
// It tracks a per-channel high-water mark over `Cursor`s and resolves a waiter as
// soon as the mark reaches its seq. seq is room-monotonic and arrives in order, so
// a high-water mark is enough — and it stays O(channels), not O(writes-ever-seen).
// The comparator is injectable: numeric DO seqs are the default; a v2 Postgres LSN
// (string) is "swap the comparator," nothing else.

import type { Cursor } from '../protocol.ts'

export type CursorCompare = (a: Cursor, b: Cursor) => number

// Default comparator: numeric seqs compare numerically. String cursors fall back
// to plain string comparison — fine for fixed-width/zero-padded cursors; a
// structured cursor like a Postgres LSN should pass its own comparator.
export function compareCursor(a: Cursor, b: Cursor): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

type Waiter = {
  channel: string
  seq: Cursor
  resolve: () => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class SeqTracker {
  private highest = new Map<string, Cursor>()
  private waiters = new Set<Waiter>()

  constructor(private compare: CursorCompare = compareCursor) {}

  // highest cursor observed on a channel (undefined if none yet).
  highWater(channel: string): Cursor | undefined {
    return this.highest.get(channel)
  }

  // Record an applied cursor and resolve any waiters the mark now satisfies. Never
  // lowers the mark — an out-of-order straggler can't un-settle a later write.
  observe(channel: string, seq: Cursor): void {
    const prev = this.highest.get(channel)
    if (prev === undefined || this.compare(seq, prev) > 0) this.highest.set(channel, seq)
    const mark = this.highest.get(channel) as Cursor
    for (const w of this.waiters) {
      if (w.channel === channel && this.compare(mark, w.seq) >= 0) this.settle(w)
    }
  }

  // Resolve once `seq` has been observed on `channel`. If `timeoutMs` is given (and
  // finite) and the seq hasn't arrived by then, reject — the caller surfaces/retries
  // instead of hanging forever. (§7: we wait on the stream, not the bare ack, so the
  // overlay doesn't flicker; reconnect's `?since` is the real re-delivery path, which
  // is why a timeout here is safe — a committed write still arrives on reconnect.)
  waitFor(channel: string, seq: Cursor, timeoutMs?: number): Promise<void> {
    const mark = this.highest.get(channel)
    if (mark !== undefined && this.compare(mark, seq) >= 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { channel, seq, resolve, reject }
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
        w.timer = setTimeout(() => {
          this.waiters.delete(w)
          reject(new Error(`settlement timed out after ${timeoutMs}ms (channel "${channel}", seq ${seq})`))
        }, timeoutMs)
        // a pending settlement shouldn't keep a Node process alive (no-op in browsers)
        ;(w.timer as { unref?: () => void }).unref?.()
      }
      this.waiters.add(w)
    })
  }

  private settle(w: Waiter): void {
    if (w.timer) clearTimeout(w.timer)
    this.waiters.delete(w)
    w.resolve()
  }

  // Reject every pending waiter — e.g. the stream closed for good, so nothing will
  // settle. Callers get a rejection (→ rollback/retry) rather than a silent hang.
  rejectAll(reason: string): void {
    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.reject(new Error(reason))
    }
    this.waiters.clear()
  }
}
