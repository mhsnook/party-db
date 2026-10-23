import { useState } from 'react'
import type { Collection } from '@tanstack/db'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useAgent } from 'agents/react'
import { collections, type BoardState, type Note, type Task } from './schema.ts'
import { createPartyDb, partyTransport } from '../../src/client/index.ts'

// ✅ 1. The party-db socket: `party: 'board'` names the Agent's binding.
const transport = partyTransport({ host: location.host, room: 'demo', party: 'board' })

// ✅ 2. The collections, from the same list the agent persists into.
export const { db } = createPartyDb(transport, collections)

// re-asserted only because this repo imports @tanstack/db twice (see example-react)
const tasks = db.tasks as unknown as Collection<Task, string>
const notes = db.notes as unknown as Collection<Note, string>

export function App() {
  const [text, setText] = useState('')

  // ✅ 3. The agent's own state rides the Agents SDK socket, beside party-db's.
  const [board, setBoard] = useState<BoardState>()
  useAgent<BoardState>({ agent: 'board', name: 'demo', host: location.host, onStateUpdate: setBoard })

  // ✅ 4. Live queries over rows that humans and the agent both write.
  const { data, isLoading } = useLiveQuery((q) => q.from({ task: tasks }).orderBy(({ task }) => task.id, 'asc'))

  function add(e: React.SubmitEvent) {
    e.preventDefault()
    const value = text.trim()
    if (!value) return
    // the insert fans out to every tab, and the agent in the room picks it up.
    tasks.insert({ id: crypto.randomUUID(), text: value, status: 'open' })
    setText('')
  }

  return (
    <>
      <h1>party-db + agents</h1>
      <p className="sub">
        Add a task. The agent in the room works it and writes its notes into the same
        collections you are reading. Open a second tab to watch both.
      </p>

      <form onSubmit={add}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="new task" autoComplete="off" />
        <button type="submit">add</button>
      </form>

      <ul>
        {data.map((task: Task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </ul>

      <p className="count">
        {isLoading
          ? 'connecting…'
          : board === undefined
            ? `${data.length} tasks · agent connecting…`
            : `${data.length} tasks · agent ${board.working ? 'working' : 'idle'} · ${board.triaged} triaged`}
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

function TaskRow({ task }: { task: Task }) {
  const { data } = useLiveQuery((q) => q.from({ note: notes }).where(({ note }) => eq(note.task_id, task.id)).orderBy(({ note }) => note.id, 'asc'))
  return (
    <li className={task.status}>
      <div className="row">
        <input
          type="checkbox"
          checked={task.status === 'done'}
          onChange={(e) => tasks.update(task.id, (d) => void (d.status = e.target.checked ? 'done' : 'open'))}
        />
        <span>{task.text}</span>
        <em>{task.status}</em>
        <button onClick={() => tasks.delete(task.id)}>✕</button>
      </div>
      {data.length > 0 && (
        <ol>
          {data.map((note: Note) => (
            <li key={note.id}>{note.body}</li>
          ))}
        </ol>
      )}
    </li>
  )
}
