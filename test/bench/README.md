# Benchmarks

A growing body of microbenchmarks for party-db's hot paths. Run them by hand to
settle "does X cost us anything?" questions with a number instead of a guess.

```sh
pnpm bench
```

Benchmarks are **not** part of CI — they're machine-variable and meant for
comparison, not pass/fail gating. They run on node (`--experimental-transform-types`
+ `--experimental-sqlite`, wired into the `bench` script) against the real
`SqliteAdapter` over `node:sqlite`, the same engine the unit suite uses.

## Adding one

Create `test/bench/<name>.bench.ts` that default-exports an async `run()`, build
your cases with the `_harness.ts` helpers (`report` + `delta`), then register it
in `index.ts`. Two conventions worth keeping:

- **Fresh state per rep** via `setup()`, so reps don't compound.
- **Match `mode` to the real code path.** `mode: 'async'` awaits each op;
  `mode: 'sync'` doesn't. `await` always costs a microtask hop even on an
  already-resolved promise, so awaiting a synchronous case injects exactly the
  overhead a benchmark may be trying to measure. Model the production path
  faithfully.

## Current benchmarks

- `async-overhead` — the per-write cost of the async `PersistenceAdapter`
  contract on the synchronous embedded (DO-SQLite) deployment. Once V8 is warm,
  the delta between the production (queued + await) path and the raw-sync floor is
  **sign-unstable within ±~2 µs/op** — i.e. the async seam that buys D1-readiness
  costs at or below this microbenchmark's own noise floor, well under 1% of a real
  durable write. The `await` microtask hop, not the serialize queue, is the only
  candidate cost, and even that doesn't surface above the noise.
