// `db` is typed by collection name. These assertions run under `pnpm typecheck`; at
// runtime the file is one trivial pass. A `@ts-expect-error` that stops erroring
// fails the typecheck.

import { describe, it, expect, expectTypeOf } from 'vitest'
import { z } from 'zod'
import type { Collection } from '@tanstack/db'
import { createPartyDb } from '../src/client/party-db.ts'
import { definePartyCollection } from '../src/schema.ts'
import type { Transport } from '../src/client/sync-client.ts'

// the row type a collection was built with; comparing `Collection` itself trips
// over its private members
type RowOf<C> = C extends Collection<infer T, any> ? T : never

const transport: Transport = { subscribe: () => () => {}, send: async () => ({ accepted: [] }) }

const todoSchema = z.object({ id: z.string(), text: z.string(), done: z.boolean() })
type Todo = z.infer<typeof todoSchema>
const listSchema = z.object({ id: z.number(), title: z.string() })
type List = z.infer<typeof listSchema>

describe('db is typed by collection name', () => {
  it('types each collection by its schema', () => {
    const { db } = createPartyDb(transport, [
      definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema }),
      definePartyCollection({ name: 'lists', key: 'id', schema: listSchema }),
    ])
    expectTypeOf<RowOf<typeof db.todos>>().toEqualTypeOf<Todo>()
    expectTypeOf<RowOf<typeof db.lists>>().toEqualTypeOf<List>()
    // keyed by the key column's type: what an app writes when it annotates one
    expectTypeOf(db.todos).toExtend<Collection<Todo, string>>()
    expectTypeOf(db.lists).toExtend<Collection<List, number>>()
    // @ts-expect-error — a todo's key is a string
    db.todos.get(1)
    // @ts-expect-error — a name the app never declared
    void db.tods
    expect(db.todos).toBeDefined()
  })

  it('keys a plain object literal by its name', () => {
    const { db } = createPartyDb(transport, [{ name: 'notes', key: 'id' }])
    expectTypeOf(db).toHaveProperty('notes')
    // @ts-expect-error — a name the app never declared
    void db.nope
  })

  it('falls back to Collection<any> for a config whose name widened', () => {
    // an explicit row type stops TypeScript inferring the literal name
    const explicit = definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })
    const { db } = createPartyDb(transport, [explicit])
    expectTypeOf<RowOf<typeof db.todos>>().toBeAny()
    // still usable the way every collection was before names were typed
    db.todos.insert({ id: 'a', text: 'x', done: false })
  })

  it('keeps persist and client as they were', () => {
    const { persist, client } = createPartyDb(transport, [{ name: 'notes', key: 'id' }])
    expectTypeOf(persist).toBeFunction()
    expectTypeOf(client.waitForSeq).toBeFunction()
  })
})
