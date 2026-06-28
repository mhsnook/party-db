import { useState } from 'react'
import type { Collection } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { todoSchema, type Todo } from './schema.ts'
import { createPartyDb, partyTransport, definePartyCollection, WriteError } from '../../src/client/index.ts'
import { AuthProvider, useAuth, getToken } from './auth.tsx'

// The only auth-aware line in the app: the transport sends whatever token the
// auth context holds. Everything below mutates `todos` like a normal app.
const transport = partyTransport({ host: location.host, room: 'rdbms', token: getToken })

export const { db } = createPartyDb(transport, [
  definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema }),
])

// As in the other example, re-asserting the row type is only needed because this
// app lives inside the library's repo (two copies of @tanstack/db). Types work
// natively in regular usage.
const todos = db.todos as unknown as Collection<Todo, string>

function LoginBar() {
  const { loggedIn, login, logout } = useAuth()
  const [pw, setPw] = useState('')

  if (loggedIn) {
    return (
      <p className="auth">
        🔓 logged in · <button onClick={logout}>log out</button>
      </p>
    )
  }
  return (
    <form
      className="auth"
      onSubmit={(e) => {
        e.preventDefault()
        login(pw)
        setPw('')
      }}
    >
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="password — it's s3cret" />
      <button type="submit">log in</button>
    </form>
  )
}

function Todos() {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useLiveQuery((q) =>
    q.from({ todo: todos }).orderBy(({ todo }) => todo.text, 'asc'),
  )
  const remaining = data.filter((t) => !t.done).length

  // mutations go out transparently; we just watch the result so a rejected write
  // becomes a visible error instead of a silent rollback. The transport throws a
  // WriteError carrying the status, so we can manage it by kind.
  function run(tx: { isPersisted: { promise: Promise<unknown> } }) {
    setError(null)
    tx.isPersisted.promise.catch((e: unknown) => {
      if (e instanceof WriteError && e.status === 401) setError('Write rejected — log in with the password to edit.')
      else setError(e instanceof Error ? e.message : 'Write failed.')
    })
  }

  function add(e: React.FormEvent) {
    e.preventDefault()
    const value = text.trim()
    if (!value) return
    run(todos.insert({ id: crypto.randomUUID(), text: value, done: false }))
    setText('')
  }

  return (
    <>
      <h1>party-db · rdbms + auth</h1>
      <p className="sub">
        Same synced todo list, but the server owns a real SQLite table and gates
        writes. Reads are open; editing needs the password.
      </p>

      <LoginBar />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

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
          <li key={todo.id}>
            <input
              type="checkbox"
              checked={todo.done}
              onChange={(e) => run(todos.update(todo.id, (d) => void (d.done = e.target.checked)))}
            />
            <span style={{ textDecoration: todo.done ? 'line-through' : 'none' }}>
              {todo.text}
            </span>
            <button onClick={() => run(todos.delete(todo.id))}>✕</button>
          </li>
        ))}
      </ul>

      <p className="count">
        {isLoading ? 'connecting…' : `${remaining} of ${data.length} remaining`}
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

export function App() {
  return (
    <AuthProvider>
      <Todos />
    </AuthProvider>
  )
}
