import { z } from 'zod'
import { definePartyCollection } from '../../src/schema.ts'

// Defined once, imported by both client and server
export const todoSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
})

export type Todo = z.infer<typeof todoSchema>

// Each todo has a comment thread. The collection is sliced by `todo_id`, so a tab
// loads only the threads it has open.
export const commentSchema = z.object({
  id: z.string(),
  todo_id: z.string(),
  body: z.string(),
})

export type Comment = z.infer<typeof commentSchema>

export const comments = definePartyCollection({
  name: 'comments',
  key: 'id',
  schema: commentSchema,
  sliceBy: 'todo_id',
})
