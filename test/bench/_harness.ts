// A tiny benchmark harness — the shared spine for everything under test/bench.
//
// Each benchmark file default-exports an async `run()` and registers itself in
// index.ts. A "case" is one variant to time; the harness runs it `iterations`
// times per rep, takes the median across `reps`, and reports per-op cost.
//
// IMPORTANT: a case declares `mode: 'sync' | 'async'`. Sync cases are NOT
// awaited — that's deliberate. `await x` always costs a microtask hop even when
// `x` is already resolved, so awaiting a synchronous case would inject the very
// overhead some benchmarks exist to measure. Match `mode` to the real code path
// you're modelling: the production write path awaits (async); a hypothetical
// sync deployment wouldn't.

import { hrtime } from 'node:process'

export interface BenchCase<S> {
  name: string
  // 'async' → the run loop awaits each op; 'sync' → it doesn't. See note above.
  mode: 'sync' | 'async'
  // fresh state per rep (e.g. a clean in-memory adapter), so reps don't compound.
  setup: () => S
  // one operation; `i` is the iteration index (use it to vary keys/inputs).
  run: (state: S, i: number) => unknown
}

export interface BenchResult {
  name: string
  totalMs: number
  perOpUs: number
}

const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]

export async function runCase<S>(c: BenchCase<S>, iterations: number, reps: number): Promise<BenchResult> {
  const times: number[] = []
  for (let r = 0; r < reps; r++) {
    const state = c.setup()
    const t = hrtime.bigint()
    if (c.mode === 'async') {
      for (let i = 0; i < iterations; i++) await c.run(state, i)
    } else {
      for (let i = 0; i < iterations; i++) c.run(state, i)
    }
    times.push(Number(hrtime.bigint() - t) / 1e6)
  }
  const totalMs = median(times)
  return { name: c.name, totalMs, perOpUs: (totalMs / iterations) * 1000 }
}

// Run every case and print a small table. Returns the results keyed by name so
// the caller can compute and print its own deltas.
export async function report(
  title: string,
  opts: { iterations: number; reps: number; cases: BenchCase<any>[] },
): Promise<Record<string, BenchResult>> {
  const { iterations, reps, cases } = opts
  const out: Record<string, BenchResult> = {}
  // warm up V8 / JIT before the timed reps so the first case isn't penalised.
  for (const c of cases) {
    const s = c.setup()
    for (let i = 0; i < Math.min(iterations, 2000); i++) await c.run(s, i)
  }
  for (const c of cases) out[c.name] = await runCase(c, iterations, reps)

  console.log(`\n${title}`)
  console.log(`${iterations.toLocaleString()} iterations · median of ${reps} reps\n`)
  const w = Math.max(...cases.map((c) => c.name.length))
  for (const c of cases) {
    const r = out[c.name]
    console.log(`  ${c.name.padEnd(w)}  ${r.totalMs.toFixed(1).padStart(8)} ms  ${r.perOpUs.toFixed(3).padStart(8)} µs/op`)
  }
  return out
}

// Format a per-op delta between two results as "+N.NNN µs/op (P.P%)".
export function delta(a: BenchResult, b: BenchResult): string {
  const d = a.perOpUs - b.perOpUs
  const pct = (d / a.perOpUs) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(3)} µs/op (${pct.toFixed(1)}% of ${a.name})`
}
