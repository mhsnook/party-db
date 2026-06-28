// Benchmark runner: `pnpm bench`. Each benchmark is a *.bench.ts file that
// default-exports an async run(); register it here to add it to the suite.
//
// Run needs node's TS transform (the src uses parameter properties) and the
// experimental SQLite module — both wired into the `bench` script in
// package.json. Benchmarks are NOT part of CI: they're variable by machine and
// meant for hand-run comparison, not pass/fail gating.

import asyncOverhead from './async-overhead.bench.ts'

const benches: Array<() => Promise<void>> = [asyncOverhead]

for (const b of benches) await b()
