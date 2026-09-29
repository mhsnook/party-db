import { createCollection } from '@tanstack/react-db'
import { QueryClient } from '@tanstack/react-query'
import { createAuthClient } from 'better-auth/react'
import { hc, parseResponse } from 'hono/client'
import { createApp, serverCollectionOptions } from '../party-app/client'
import type { FileRow, Todo } from '../shared/schema'
import type { AppType } from '../worker/api'

const api = hc<AppType>(location.origin).api
const queryClient = new QueryClient()

const todos = createCollection(
  serverCollectionOptions<Todo, string>({
    name: 'todos',
    queryClient,
    getKey: (t) => t.id,
    list: () => parseResponse(api.todos.$get()),
    insert: ({ id, text, done }) => parseResponse(api.todos.$post({ json: { id, text, done } })),
    update: (id, { text, done }) => parseResponse(api.todos[':id'].$patch({ param: { id }, json: { text, done } })),
    remove: (id) => parseResponse(api.todos[':id'].$delete({ param: { id } })),
  }),
)

const files = createCollection(
  serverCollectionOptions<FileRow, string>({
    name: 'files',
    queryClient,
    getKey: (f) => f.id,
    list: () => parseResponse(api.files.$get()),
    remove: (id) => parseResponse(api.files[':id'].$delete({ param: { id } })),
  }),
)

async function upload(file: File) {
  const url = api.files[':name'].$url({ param: { name: file.name } })
  const res = await fetch(url, {
    method: 'PUT',
    body: file,
    headers: { 'content-type': file.type || 'application/octet-stream' },
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`)
  files.utils.writeUpsert((await res.json()) as FileRow)
}

const imageUrl = (id: string, width: number) =>
  api.files[':id'].image.$url({ param: { id }, query: { w: String(width) } }).href

export const app = createApp({
  queryClient,
  collections: { todos, files },
  api,
  auth: createAuthClient(),
  storage: { upload, imageUrl },
})
