import { useState } from 'react'
import type { Collection } from '@tanstack/db'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { comments as commentsConfig, todoSchema, type Comment, type Todo } from './schema.ts'
import { createPartyDb, partyTransport, definePartyCollection } from '../../src/client/index.ts'

// ✅ 1. Connect to your PartyServer w/ a thin wrapper on PartySocket
const transport = partyTransport({ host: location.host, room: 'demo' })

// ✅ 2. Pass that connection to the constructor, and you're done!
export const { db } = createPartyDb(transport, [
  definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema }),
  commentsConfig,
])

// db.todos is a plain TanStack DB collection; the only reason we need
// to re-assert the row type as Collection<Todo> is because of the structure
// of _this_ repo (an example app inside the library's repo) where tanstack/db
// gets imported twice. Types should work natively in regular usage.
const todos = db.todos as unknown as Collection<Todo, string>
const comments = db.comments as unknown as Collection<Comment, string>

// ✅ 5. A sliced collection loads one thread at a time: the live query's `where`
// is the subscription, and comments on other todos never reach this tab.
function Thread({ todoId }: { todoId: string }) {
  const [body, setBody] = useState('')
  const { data } = useLiveQuery(
    (q) => q.from({ c: comments }).where(({ c }) => eq(c.todo_id, todoId)),
    [todoId],
  )

  function add(e: React.SubmitEvent) {
    e.preventDefault()
    const value = body.trim()
    if (!value) return
    comments.insert({ id: crypto.randomUUID(), todo_id: todoId, body: value })
    setBody('')
  }

  return (
    <div className="thread">
      {data.map((c: Comment) => (
        <p key={c.id}>{c.body}</p>
      ))}
      <form onSubmit={add}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="comment" autoComplete="off" />
        <button type="submit">post</button>
      </form>
    </div>
  )
}

export function App() {
  const [text, setText] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  // ✅ 3. Now you can use your reactive live queries like normal!
  const { data, isLoading } = useLiveQuery((q) =>
    q.from({ todo: todos }).orderBy(({ todo }) => todo.text, 'asc'),
  )

  const remaining = data.filter((t) => !t.done).length

  function add(e: React.SubmitEvent) {
    e.preventDefault()
    const value = text.trim()
    if (!value) return

	 // ✅ 4. Optimistic updates also work out of the box, without
	 // having to define the collection's `onInsert` function.
    todos.insert({ id: crypto.randomUUID(), text: value, done: false })
    setText('')
  }

  return (
    <>
      <h1>party-db</h1>
      <p className="sub">
        React + <code>useLiveQuery</code>. Open this page in two tabs and watch
        them sync.
      </p>

      <form onSubmit={add}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="new todo"
          autoComplete="off"
        />
        <button type="submit">add</button>
      </form>

      <ul>
        {data.map((todo: Todo) => (
          <li key={todo.id} className={open === todo.id ? 'open' : undefined}>
            <input
              type="checkbox"
              checked={todo.done}
              onChange={(e) =>
                todos.update(todo.id, (d) => void (d.done = e.target.checked))
              }
            />
            <span style={{ textDecoration: todo.done ? 'line-through' : 'none' }}>
              {todo.text}
            </span>
            <button onClick={() => setOpen(open === todo.id ? null : todo.id)}>comments</button>
            <button onClick={() => todos.delete(todo.id)}>✕</button>
            {open === todo.id && <Thread todoId={todo.id} />}
          </li>
        ))}
      </ul>

      <p className="count">
        {isLoading
          ? 'connecting…'
          : `${remaining} of ${data.length} remaining`}
      </p>

      <footer>
        Synced with <strong>party-db</strong> &middot;{' '}
        <a href="https://github.com/mhsnook/party-db" target="_blank" rel="noopener">
          see the code &rarr;
        </a>
      </footer>
    </>
  )
}
