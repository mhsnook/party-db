import { z } from 'zod'
import { definePartyCollection } from '../../src/index.ts'

// Defined once, imported by both halves: the browser builds its TanStack DB
// collections from this list, and the agent's Durable Object persists into it.
export const taskSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(['open', 'working', 'done']),
})

export const noteSchema = z.object({
  id: z.string(),
  task_id: z.string(), // → tasks.id
  body: z.string(),
})

export type Task = z.infer<typeof taskSchema>
export type Note = z.infer<typeof noteSchema>

export const collections = [
  definePartyCollection<Task>({ name: 'tasks', key: 'id', schema: taskSchema }),
  definePartyCollection<Note>({ name: 'notes', key: 'id', schema: noteSchema }),
]

// What the agent reports about itself, outside the collections: the Agents SDK
// syncs this one object to `useAgent` on every `setState`.
export type BoardState = { working: string | null; triaged: number }
