import { Schema } from 'effect'
import { definePartyCollection } from '../../../src/index.ts'

export const Todo = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  done: Schema.Boolean,
})
export type Todo = typeof Todo.Type

// A bare Struct is not a StandardSchema. The wrapper keeps the Struct's AST, which
// the server reads to find the table's columns.
export const todos = definePartyCollection({
  name: 'todos',
  key: 'id',
  schema: Schema.toStandardSchemaV1(Todo),
})

export class WriteFailed extends Schema.TaggedError<WriteFailed>()('WriteFailed', {
  reason: Schema.String,
}) {}
