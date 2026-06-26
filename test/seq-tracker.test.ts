import { describe, it, expect } from 'vitest'
import { SeqTracker, compareCursor } from '../src/client/seq-tracker.ts'

describe('SeqTracker.waitFor settlement', () => {
  it('resolves once the awaited seq is observed', async () => {
    const t = new SeqTracker()
    let settled = false
    const p = t.waitFor('c', 3).then(() => (settled = true))
    expect(settled).toBe(false)
    t.observe('c', 3)
    await p
    expect(settled).toBe(true)
  })

  it('resolves immediately when the high-water mark already passed the seq', async () => {
    const t = new SeqTracker()
    t.observe('c', 5)
    await expect(t.waitFor('c', 3)).resolves.toBeUndefined()
  })

  it('resolves a waiter whose seq sits between observed seqs (high-water, not equality)', async () => {
    const t = new SeqTracker()
    const p = t.waitFor('c', 4)
    t.observe('c', 5) // jumps past 4
    await expect(p).resolves.toBeUndefined()
  })

  it('keeps the mark monotonic when a lower seq arrives late', async () => {
    const t = new SeqTracker()
    t.observe('c', 5)
    t.observe('c', 3) // straggler, must not lower the mark
    expect(t.highWater('c')).toBe(5)
    await expect(t.waitFor('c', 5)).resolves.toBeUndefined()
  })

  it('tracks channels independently', async () => {
    const t = new SeqTracker()
    t.observe('a', 9)
    let bSettled = false
    t.waitFor('b', 2).then(() => (bSettled = true))
    await Promise.resolve()
    expect(bSettled).toBe(false)
  })
})

describe('SeqTracker timeout', () => {
  it('rejects after the timeout when the seq never arrives', async () => {
    const t = new SeqTracker()
    await expect(t.waitFor('c', 1, 10)).rejects.toThrow(/timed out/)
  })

  it('does not reject if it settles before the timeout', async () => {
    const t = new SeqTracker()
    const p = t.waitFor('c', 1, 50)
    t.observe('c', 1)
    await expect(p).resolves.toBeUndefined()
  })

  it('waits indefinitely when no timeout is given (no spurious rejection)', async () => {
    const t = new SeqTracker()
    let outcome: string | undefined
    t.waitFor('c', 1).then(
      () => (outcome = 'resolved'),
      () => (outcome = 'rejected'),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(outcome).toBeUndefined() // still pending
  })
})

describe('SeqTracker.rejectAll', () => {
  it('rejects every pending waiter (stream closed for good)', async () => {
    const t = new SeqTracker()
    const p = t.waitFor('c', 1)
    t.rejectAll('closed')
    await expect(p).rejects.toThrow(/closed/)
  })
})

describe('compareCursor + custom comparators', () => {
  it('default: numeric seqs compare numerically', () => {
    expect(compareCursor(2, 10)).toBeLessThan(0)
    expect(compareCursor(10, 2)).toBeGreaterThan(0)
    expect(compareCursor(5, 5)).toBe(0)
  })

  it('default: string cursors compare lexically', () => {
    expect(compareCursor('a', 'b')).toBeLessThan(0)
    expect(compareCursor('b', 'b')).toBe(0)
  })

  it('honors an injected comparator (e.g. a structured cursor)', async () => {
    // a comparator that orders dotted "x/y" cursors by their numeric segments —
    // the kind of thing a Postgres LSN would need (lexical "0/9" > "0/10" is wrong)
    const lsn = (a: string, b: string) => {
      const [a1, a2] = a.split('/').map(Number)
      const [b1, b2] = b.split('/').map(Number)
      return a1 - b1 || a2 - b2
    }
    const t = new SeqTracker(lsn as any)
    t.observe('c', '0/10')
    // '0/9' < '0/10' numerically, so a waiter for it is already satisfied
    await expect(t.waitFor('c', '0/9')).resolves.toBeUndefined()
    expect(t.highWater('c')).toBe('0/10')
  })
})
