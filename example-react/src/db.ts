// Build the party-db client once, at module scope, and share the live
// collections everywhere. createPartyDb opens a single PartySocket and returns
// normal TanStack DB collections — exactly what @tanstack/react-db's
// useLiveQuery wants to read from.
import type { Collection } from '@tanstack/db'
import { createPartyDb, partyTransport, definePartyCollection } from '../../src/client/index.ts'
import { todoSchema, type Todo } from './schema.ts'

const transport = partyTransport({ host: location.host, room: 'demo' })

export const { db } = createPartyDb(transport, [
  definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema }),
])

// db.todos is a plain TanStack DB collection: insert/update/delete optimistically,
// and feed it to useLiveQuery to render it reactively. We re-assert the row type
// as Collection<Todo> here: createPartyDb stores collections loosely (one map for
// many tables), and this is also the @tanstack/db copy useLiveQuery is typed
// against (see vite.config.ts `dedupe`), so the query columns come out typed.
export const todos = db.todos as unknown as Collection<Todo, string>
