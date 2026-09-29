import { z } from 'zod'

export const todoSchema = z.object({
  id: z.uuid(),
  text: z.string().min(1).max(500),
  done: z.boolean(),
  created_at: z.string(),
})
export type Todo = z.infer<typeof todoSchema>
export const todoInsert = todoSchema.pick({ id: true, text: true, done: true })
export const todoPatch = todoSchema.pick({ text: true, done: true }).partial()

export const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  content_type: z.string(),
  size: z.number(),
  created_at: z.string(),
})
export type FileRow = z.infer<typeof fileSchema>
