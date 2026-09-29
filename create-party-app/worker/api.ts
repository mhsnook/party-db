import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { publish } from '../party-app/server'
import { todoInsert, todoPatch, type FileRow, type Todo } from '../shared/schema'
import { auth, type User } from './auth'

type AppEnv = { Bindings: Env; Variables: { user: User } }

const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return c.json({ error: 'Sign in to continue.' }, 401)
  c.set('user', session.user)
  await next()
})

type TodoRow = Omit<Todo, 'done'> & { done: number }
const toTodo = ({ done, ...rest }: TodoRow): Todo => ({ ...rest, done: done === 1 })
const TODO_COLS = 'id, text, done, created_at'

const todos = new Hono<AppEnv>()
  .use(requireUser)
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare(
      `select ${TODO_COLS} from todos where user_id = ? order by created_at`,
    )
      .bind(c.var.user.id)
      .all<TodoRow>()
    return c.json(results.map(toTodo))
  })
  .post('/', zValidator('json', todoInsert), async (c) => {
    const t = c.req.valid('json')
    const row = await c.env.DB.prepare(
      `insert into todos (id, user_id, text, done) values (?, ?, ?, ?) returning ${TODO_COLS}`,
    )
      .bind(t.id, c.var.user.id, t.text, t.done ? 1 : 0)
      .first<TodoRow>()
    const todo = toTodo(row!)
    await publish(c.env.Realtime, c.var.user.id, { channel: 'todos', upsert: [todo] })
    return c.json(todo, 201)
  })
  .patch('/:id', zValidator('json', todoPatch), async (c) => {
    const p = c.req.valid('json')
    const row = await c.env.DB.prepare(
      `update todos set text = coalesce(?, text), done = coalesce(?, done)
       where id = ? and user_id = ? returning ${TODO_COLS}`,
    )
      .bind(p.text ?? null, p.done === undefined ? null : p.done ? 1 : 0, c.req.param('id'), c.var.user.id)
      .first<TodoRow>()
    if (!row) return c.json({ error: 'No such todo.' }, 404)
    const todo = toTodo(row)
    await publish(c.env.Realtime, c.var.user.id, { channel: 'todos', upsert: [todo] })
    return c.json(todo)
  })
  .delete('/:id', async (c) => {
    const row = await c.env.DB.prepare('delete from todos where id = ? and user_id = ? returning id')
      .bind(c.req.param('id'), c.var.user.id)
      .first<{ id: string }>()
    if (!row) return c.json({ error: 'No such todo.' }, 404)
    await publish(c.env.Realtime, c.var.user.id, { channel: 'todos', delete: [row.id] })
    return c.json({ id: row.id })
  })

const FILE_COLS = 'id, name, content_type, size, created_at'
const objectKey = (userId: string, fileId: string) => `${userId}/${fileId}`

async function ownedObject(c: Context<AppEnv>, fileId: string) {
  const row = await c.env.DB.prepare('select id from files where id = ? and user_id = ?')
    .bind(fileId, c.var.user.id)
    .first()
  return row ? c.env.FILES.get(objectKey(c.var.user.id, fileId)) : null
}

const files = new Hono<AppEnv>()
  .use(requireUser)
  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare(
      `select ${FILE_COLS} from files where user_id = ? order by created_at`,
    )
      .bind(c.var.user.id)
      .all<FileRow>()
    return c.json(results)
  })
  // the body streams straight to R2, so the upload never sits in Worker memory
  .put('/:name', async (c) => {
    const body = c.req.raw.body
    if (!body) return c.json({ error: 'Send the file as the request body.' }, 400)
    const id = crypto.randomUUID()
    const contentType = c.req.header('content-type') ?? 'application/octet-stream'
    const object = await c.env.FILES.put(objectKey(c.var.user.id, id), body, {
      httpMetadata: { contentType },
    })
    const row = await c.env.DB.prepare(
      `insert into files (id, user_id, name, content_type, size) values (?, ?, ?, ?, ?) returning ${FILE_COLS}`,
    )
      .bind(id, c.var.user.id, c.req.param('name'), contentType, object.size)
      .first<FileRow>()
    await publish(c.env.Realtime, c.var.user.id, { channel: 'files', upsert: [row!] })
    return c.json(row!, 201)
  })
  .get('/:id/content', async (c) => {
    const object = await ownedObject(c, c.req.param('id'))
    if (!object) return c.json({ error: 'No such file.' }, 404)
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    return new Response(object.body, { headers })
  })
  .get('/:id/image', zValidator('query', z.object({ w: z.coerce.number().int().min(16).max(2048) })), async (c) => {
    const object = await ownedObject(c, c.req.param('id'))
    if (!object) return c.json({ error: 'No such file.' }, 404)
    if (!object.httpMetadata?.contentType?.startsWith('image/')) {
      return c.json({ error: 'That file is not an image.' }, 415)
    }
    const result = await c.env.IMAGES.input(object.body)
      .transform({ width: c.req.valid('query').w })
      .output({ format: 'image/webp' })
    return result.response({ headers: { 'cache-control': 'private, max-age=3600' } })
  })
  .delete('/:id', async (c) => {
    const row = await c.env.DB.prepare('delete from files where id = ? and user_id = ? returning id')
      .bind(c.req.param('id'), c.var.user.id)
      .first<{ id: string }>()
    if (!row) return c.json({ error: 'No such file.' }, 404)
    await c.env.FILES.delete(objectKey(c.var.user.id, row.id))
    await publish(c.env.Realtime, c.var.user.id, { channel: 'files', delete: [row.id] })
    return c.json({ id: row.id })
  })

export const app = new Hono<AppEnv>()
  .basePath('/api')
  .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
  .route('/todos', todos)
  .route('/files', files)

export type AppType = typeof app
