# Commands: one function, run on both sides

Status: a design under review, for [#34](https://github.com/mhsnook/party-db/issues/34).
Nothing here is built. The test skeletons are in `test/commands.test.ts`.
Implementation is a separate change, after review.

## The case

Some writes depend on state only the room has. pomoduo's shared clock is the worked
example. A press like `start` or `nudge +10s` has to be applied at the room's time,
against the room's clock row and the members the room counts as present. The room
also changes the clock on its own, from an alarm, when a phase ends.

party-db offers two ways to write that today, and neither fits:

- **CRUD through `/write`.** The client computes the rows. Here the client's time and
  its view of the members are estimates, so its rows are guesses.
- **Host code plus `commit()` (§14), behind an endpoint of the host's own.** The rows
  are right. But the app rebuilds the optimistic overlay, settlement, ordering and
  retry by hand.

pomoduo took the second path, and its hand-built copy has four bugs:

1. Two quick presses are two concurrent fetches, so the room can apply them in the
   other order.
2. Fire-and-forget member writes (vote, mute, name) race the same way, with nothing
   to settle them.
3. When another member's change arrives while a press is unanswered, the device
   drops its own prediction, then snaps forward when the answer comes.
4. A press made while offline fails, and nothing retries it.

A command closes the gap. The app writes one function. The client runs it against its
collections, and that is the overlay. The room runs it again inside the write queue,
and that is the truth: its writes go through the same commit path a POST does. The
ack carries the seqs, and the client settles on them as it does for any write (§7).

## Shape

One definition, imported on both sides, like a collection:

```ts
export const press = defineCommand({
  name: 'press',
  args: commandSchema, // any Standard Schema; the room validates with it
  reads: [clock, members],
  writes: [clock],
  run(tx, args, ctx) {
    const row = tx.clock.get(CLOCK_ROW_ID)
    const votes = tx.members.rows().filter((m) => m.here).map((m) => m.vote)
    const next = apply(clockOf(row), args, ctx.now, votes)
    if (next) tx.clock.update(CLOCK_ROW_ID, rowOf(next, ctx))
  },
})
```

The client calls it. The call returns TanStack's transaction, so it is awaited and
rolled back like any other write:

```ts
const { db, commands } = createPartyDb(transport, [clock, members], {
  commands: [press],
  now: serverNow, // optional; defaults to Date.now
})
const tx = commands.press({ type: 'start' })
await tx.isPersisted.promise
```

The room declares it next to its collections, and host code can run it too:

```ts
export class Session extends PartyDbServer<Env> {
  collections = [clock, members]
  commands = [press]

  async onAlarm() {
    await this.run(press, { type: 'rollover' })
  }
}
```

### `run`

- **It is synchronous on both sides.** TanStack's `onMutate` must be synchronous. In
  the room, a synchronous `run` holds nothing open across an await.
- **`tx` has one handle per declared channel.** Reads are `get(key)` and `rows()`.
  Writes are `insert(row)`, `update(key, changes)` and `delete(key)`. A read sees the
  run's own earlier writes. A channel missing from `reads` or `writes` is not on `tx`,
  in the types or at runtime.
- **`ctx` carries the call's context.** `now` is the room's `Date.now()` in the room,
  and the `now` option on the client. `calledAt` is the client's `now` at the call,
  sent with the command, so a command can refuse to apply a stale press. `id` is the
  command id. `identity` is the writer's verified identity in the room, and null on
  the client.
- **A throw refuses the command.** In the room it commits nothing, and the client gets
  a 409 `WriteReject` carrying the message. On the client it skips the overlay, but
  the command is still sent, because the room's view decides.

## The client half

The client half is TanStack's `createOptimisticAction`. Its `onMutate` runs `run`
against the collections. Its `mutationFn` sends the command and awaits the acked seqs
with `waitForSeq`. So the overlay is TanStack's own: the rows `run` wrote, held until
settlement, then dropped onto the synced rows.

**No rebase in this version.** While a command is unsettled, TanStack holds the rows it
wrote over the synced rows. If another client writes the same row in that time, the
change shows once this command settles. That matches pomoduo's own rule: a device keeps
its prediction until every press it made is answered. Rebasing would mean running the
pending commands again over each synced change. TanStack does not run `onMutate` again,
so rebasing would put a second overlay beside TanStack's. Leave it out until an app
needs it.

**One send queue per client.** `SyncClient.send` waits for the previous send's ack
before it sends the next. It does not wait for settlement. The ack means the room has
committed, so the next write commits after it. The queue covers commands and CRUD
writes alike. It costs one round trip per write in a burst.

**Retry on no response.** If a send gets no response (a `TransportError`), the client
sends it again with the same id once the socket reopens, with backoff. The queue head
blocks the writes behind it, so the order holds. A verdict from the room (a
`WriteError`) is not retried, and the overlay rolls back. If the client gives up after
`retryForMs`, it rejects with the `TransportError` and rolls back. Unsent commands do
not survive a page reload, because TanStack holds transactions in memory.

## The room half

- **The wire.** A command rides `POST /write` with the body `{ command, id, args,
  calledAt }`, beside today's `WriteBatch[]`. This adds to the wire, so the client and
  room change together, invisibly to userspace. It gets the same size caps, the same
  `auth` hook, and the same fail-closed handling of anonymous writes.
- **Checks.** An unknown name is a 400. Args that fail the schema are a 400 with the
  schema's message.
- **One serialized section.** Inside `serialize`, the room loads every declared channel
  whole, through `adapter.snapshot(channel)`. It runs `run` against that in-memory view
  and collects the writes as `WriteBatch[]`. It then writes and fans them out exactly
  as `commitSection` does. The load, the run and the write share one section, so no
  other write lands in between. Loading whole channels suits room-sized tables. A
  sliced or keyed load can come later.
- **Access.** A command's code is the room's own, so its writes skip the per-op write
  gate, as `commit()` does. Two limits hold:
  - it writes only the channels it declares;
  - its fan-out follows each collection's read policy.

  A command that needs a per-user check makes it with `ctx.identity`.
- **The ack.** The room answers with a `WriteAck`, as `/write` does. `accepted` lists
  only what the caller may read.
- **Host runs.** `this.run(command, args)` runs the same section from host code: an
  alarm, a job. It carries no id, so it is never deduplicated.

### Running a command once

The room records each command's id on the `_oplog` entries it writes, in a new nullable
`command_id` column. Before a command runs, the room looks its id up. If the id is
there, the room answers with those entries' seqs and does not run the command again.
The window is the oplog's retention.

A command that wrote nothing leaves no entry, so a retry of it runs again. Most such
commands are no-ops both times. A command where that matters can check `ctx.calledAt`.

This changes durable state. The column is new and nullable, and the stored ops keep
their shape. Older entries read as null, so they never match an id.

## What this is not

- **Not a Postgres-function RPC.** `postgres-todo.md` §4 plans those. They run in the
  database. A command runs in the room's JavaScript.
- **Not #34's server-function kind.** That kind runs in TanStack Start's server
  runtime. A command runs in the room and does not depend on Start.
- **Not a way in for writes from outside the room.** Those still wait for the WAL
  story.

## Decisions for the maintainer

1. **The send queue.** Queue every write, or only commands? Recommend every write. One
   client's writes then reach the room in the order it made them. The cost is one
   round trip per write in a burst.
2. **Where the idempotency record lives.** In `_oplog.command_id`, or in memory?
   Recommend `_oplog`. An in-memory record is lost when the Durable Object is evicted,
   and a retry after an eviction would then apply twice.
3. **The wire envelope.** Give a command its own body, or use the reserved-channel op
   that `postgres-todo.md` §4 sketches for RPCs? Recommend its own body for now. Merge
   the two envelopes if Postgres RPCs land and they turn out to be the same thing.
4. **How the room reads.** Load declared channels whole on every adapter, or allow
   commands only on embedded SQLite and read it synchronously? Recommend loading
   whole, with the limit documented. One code path then serves all three adapters.
5. **A throw on the client.** Skip the overlay and still send, or refuse without
   sending? Recommend still sending. The client's view is an estimate, and the room
   decides.

## Done when

- pomoduo's `src/client/session/connection.ts` drops its own command ids, the
  `revision` comparison and its fire-and-forget helper.
- pomoduo's clock and member writes go through commands, and its room's alarm calls
  `this.run`.
- The cases in `test/commands.test.ts` pass, including two quick commands from one
  client applying in order, and a command retried after a lost ack applying once.
