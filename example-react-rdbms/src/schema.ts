import { z } from 'zod'

// Defined once, imported by both client and server. Unlike the schemaless
// example, here the server uses this same schema to build the column allowlist
// for structured CRUD against a real `todos` table (see server.ts).
export const todoSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
})

export type Todo = z.infer<typeof todoSchema>
