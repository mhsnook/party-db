import { z } from 'zod'

// Defined once, imported by both client and server (the server only needs the
// shape if it wants to validate; storage is schema-agnostic blobs).
export const todoSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
})

export type Todo = z.infer<typeof todoSchema>
