// The client half of read slicing (docs/architecture.md §18): which slices of one
// sliced channel this client is subscribed to, and the cursor each released slice
// was dropped at.
//
// TanStack DB drives it. A live query on an on-demand collection calls
// `loadSubset` with its `where`, and `unloadSubset` with the same options when it
// goes away; `sliceTargets` reads the `sliceBy` equality out of that `where`.

import { parseWhereExpression, type LoadSubsetOptions } from '@tanstack/db'
import { sliceText, type Cursor, type SequencedBatch, type SliceValue, type UpFrame } from '../protocol.ts'

// A subscription target: one slice value, or `null` for the whole channel.
export type SliceTarget = SliceValue | null

const ANY = Symbol('any slice')
type Targets = SliceValue[] | typeof ANY

const isSliceValue = (v: unknown): v is SliceValue => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

// The slices a `where` can match. An equality or `inArray` on the `sliceBy` column
// narrows it; `and` intersects, `or` unions. Anything else constrains nothing, so
// the query loads the whole channel — over-fetching is always safe here, because
// the live query still filters the rows it shows.
export function sliceTargets(where: LoadSubsetOptions['where'], column: string): SliceTarget[] {
  const isColumn = (field: unknown) => Array.isArray(field) && field.length === 1 && field[0] === column
  const result = parseWhereExpression<Targets>(where, {
    handlers: {
      eq: (field: unknown, value: unknown) => (isColumn(field) && isSliceValue(value) ? [value] : ANY),
      in: (field: unknown, values: unknown) =>
        isColumn(field) && Array.isArray(values) && values.every(isSliceValue) ? (values as SliceValue[]) : ANY,
      and: (...parts: Targets[]) => {
        const narrowing = parts.filter((p): p is SliceValue[] => p !== ANY)
        if (!narrowing.length) return ANY
        return narrowing.reduce((acc, part) => {
          const texts = new Set(part.map(sliceText))
          return acc.filter((v) => texts.has(sliceText(v)))
        })
      },
      or: (...parts: Targets[]) => (parts.some((p) => p === ANY) ? ANY : (parts as SliceValue[][]).flat()),
    },
    onUnknownOperator: () => ANY,
  })
  if (result === null || result === ANY) return [null]
  const seen = new Map(result.map((v) => [sliceText(v), v]))
  return [...seen.values()]
}

type Waiter = { resolve: () => void; reject: (error: Error) => void }

type Entry = {
  target: SliceTarget
  refs: number
  loaded: boolean
  // the cursor this subscribe asks from, until its reply arrives
  since?: Cursor
  waiters: Waiter[]
}

const keyOf = (target: SliceTarget) => (target === null ? '*' : `=${sliceText(target)}`)

export class ChannelSlices {
  private entries = new Map<string, Entry>()
  // released slices: the room seq they were dropped at. Their rows stay in the
  // collection, so subscribing again asks only for what changed after this.
  private cursors = new Map<string, Cursor>()

  constructor(
    readonly channel: string,
    readonly column: string,
    private send: (frame: UpFrame) => void,
    private roomSeq: () => Cursor | undefined,
  ) {}

  accepts(row: Record<string, unknown>): boolean {
    return this.entries.has('*') || this.entries.has(keyOf(sliceText(row[this.column])))
  }

  acquire(targets: SliceTarget[]): true | Promise<void> {
    const waits: Promise<void>[] = []
    for (const target of targets) {
      const key = keyOf(target)
      let entry = this.entries.get(key)
      if (!entry) {
        entry = { target, refs: 0, loaded: false, since: this.cursors.get(key), waiters: [] }
        this.cursors.delete(key)
        this.entries.set(key, entry)
        this.send(this.subscribeFrame(entry))
      }
      entry.refs++
      if (!entry.loaded) waits.push(this.wait(entry))
    }
    return waits.length ? Promise.all(waits).then(() => {}) : true
  }

  // A release waits a microtask before unsubscribing: TanStack re-loads every
  // subset right after a truncate by unloading and loading it again, and that
  // pair must not cost a round trip.
  release(targets: SliceTarget[]): void {
    for (const target of targets) {
      const key = keyOf(target)
      const entry = this.entries.get(key)
      if (!entry) continue
      entry.refs--
      if (entry.refs > 0) continue
      queueMicrotask(() => {
        if (this.entries.get(key) !== entry || entry.refs > 0) return
        this.entries.delete(key)
        const seq = this.roomSeq()
        if (entry.loaded && seq !== undefined) this.cursors.set(key, seq)
        for (const w of entry.waiters.splice(0)) w.resolve()
        this.send(target === null ? { unsubscribe: this.channel } : { unsubscribe: this.channel, slice: target })
      })
    }
  }

  // After a batch applied: a `ready` batch is the end of a subscribe's reply.
  // Its waiters resolve once TanStack says the rows are visible.
  applied(batch: SequencedBatch, receipt: true | Promise<void>): void {
    if (batch.reset && batch.slice === undefined) this.cursors.clear() // the rows they pointed at are gone
    if (!batch.ready) return
    const entry = this.entries.get(keyOf(batch.slice === undefined ? null : batch.slice))
    if (!entry || entry.loaded) return
    entry.loaded = true
    entry.since = undefined
    const waiters = entry.waiters.splice(0)
    Promise.resolve(receipt).then(
      () => waiters.forEach((w) => w.resolve()),
      (error: Error) => waiters.forEach((w) => w.reject(error)),
    )
  }

  // A new socket starts with no subscriptions: ask again for each one, from the
  // last seq we saw for a loaded slice, or from where it was asking before.
  resubscribe(): void {
    for (const entry of this.entries.values()) {
      if (entry.loaded) entry.since = this.roomSeq()
      this.send(this.subscribeFrame(entry))
    }
  }

  // The collection was cleaned up and its rows dropped: no cursor still applies.
  dispose(error?: Error): void {
    for (const entry of this.entries.values()) {
      for (const w of entry.waiters.splice(0)) (error ? w.reject(error) : w.resolve())
      if (!error) this.send(entry.target === null ? { unsubscribe: this.channel } : { unsubscribe: this.channel, slice: entry.target })
    }
    this.entries.clear()
    this.cursors.clear()
  }

  private subscribeFrame(entry: Entry): UpFrame {
    return {
      subscribe: this.channel,
      ...(entry.target === null ? {} : { slice: entry.target }),
      ...(entry.since === undefined ? {} : { since: entry.since }),
    }
  }

  private wait(entry: Entry): Promise<void> {
    return new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }))
  }
}
