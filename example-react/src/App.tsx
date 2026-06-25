import { useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { todos } from './db.ts'
import type { Todo } from './schema.ts'

export function App() {
  const [text, setText] = useState('')

  // The whole point of this example: one hook, fully reactive.
  // useLiveQuery re-renders this component whenever the `todos` collection
  // changes — your own optimistic insert, the server's ack, or a write that
  // arrived over the socket from another tab. No subscribeChanges, no useState
  // mirror, no effects. Query-shape it however you like (filter/sort/join);
  // here we just sort by text.
  const { data, isLoading } = useLiveQuery((q) =>
    q.from({ todo: todos }).orderBy(({ todo }) => todo.text, 'asc'),
  )

  const remaining = data.filter((t) => !t.done).length

  function add(e: React.FormEvent) {
    e.preventDefault()
    const value = text.trim()
    if (!value) return
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
          <li key={todo.id}>
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
            <button onClick={() => todos.delete(todo.id)}>✕</button>
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
