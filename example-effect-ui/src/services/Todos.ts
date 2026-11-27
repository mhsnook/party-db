import { Context, Effect, Layer, Queue, Stream } from 'effect'
import { createPartyDb, partyTransport } from '../../../src/client/index.ts'
import { todos, WriteFailed, type Todo } from '../domain/Todo.ts'

// The UI's only door to party-db. Commands and the list query capture it, so no
// component touches the TanStack collection.
export class Todos extends Context.Service<Todos, {
  readonly list: Stream.Stream<ReadonlyArray<Todo>>
  add(text: string): Effect.Effect<void, WriteFailed>
  setDone(id: string, done: boolean): Effect.Effect<void, WriteFailed>
  remove(id: string): Effect.Effect<void, WriteFailed>
}>()('app/Todos') {
  static readonly layerParty = Layer.sync(Todos, () => {
    const { db } = createPartyDb(partyTransport({ host: location.host, room: 'demo' }), [todos])
    const collection = db.todos

    // The collection applies a write optimistically and fires its change at once.
    // `isPersisted` settles when the server's ack comes back, so a refused write
    // fails here after the row already showed and TanStack DB rolled it back.
    const write = (run: () => { isPersisted: { promise: Promise<unknown> } }) =>
      Effect.tryPromise({
        try: () => run().isPersisted.promise,
        catch: (error) => new WriteFailed({ reason: error instanceof Error ? error.message : String(error) }),
      }).pipe(Effect.asVoid)

    // Nothing is offered until the first snapshot lands, so the query reads
    // Initial ("Loading…") instead of an empty list.
    const list = Stream.callback<ReadonlyArray<Todo>>(
      Effect.fnUntraced(function* (queue) {
        const offer = () => {
          if (collection.isReady()) Queue.offerUnsafe(queue, collection.toArray)
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => collection.subscribeChanges(offer)),
          (subscription) => Effect.sync(() => subscription.unsubscribe()),
        )
        yield* Effect.promise(() => collection.toArrayWhenReady())
        offer()
      }),
    )

    return Todos.of({
      list,
      add: (text) => write(() => collection.insert({ id: crypto.randomUUID(), text, done: false })),
      setDone: (id, done) => write(() => collection.update(id, (draft) => void (draft.done = done))),
      remove: (id) => write(() => collection.delete(id)),
    })
  })
}
