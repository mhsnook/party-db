import { createPartyDb, partyTransport, definePartyCollection } from '../../src/client/index.ts'
import { todoSchema, type Todo } from './schema.ts'

// ✅ 1. Connect to your PartyServer w/ a thin wrapper on PartySocket
const transport = partyTransport({ host: location.host, room: 'demo' })

// ✅ 2. Pass that connection to the constructor, and you're done!
const { db } = createPartyDb(transport, [
  definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema }),
])

// ✅ 3. This `todos` is now just any old tanstack/db collection
const todos = db.todos

const form = document.getElementById('form') as HTMLFormElement
const input = document.getElementById('text') as HTMLInputElement
const list = document.getElementById('list') as HTMLUListElement

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text) return

  // ✅ 4. Optimistic updates work out of the box, without
  // having to define the collection's `onInsert` function.
  todos.insert({ id: crypto.randomUUID(), text, done: false })
  input.value = ''
})

function render() {
  list.replaceChildren()
  for (const t of todos.toArray as Todo[]) {
    const li = document.createElement('li')

    const done = document.createElement('input')
    done.type = 'checkbox'
    done.checked = t.done
    done.onchange = () => todos.update(t.id, (d: Todo) => void (d.done = done.checked))

    const text = document.createElement('span')
    text.textContent = t.text
    text.style.textDecoration = t.done ? 'line-through' : 'none'

    const del = document.createElement('button')
    del.textContent = '✕'
    del.onclick = () => todos.delete(t.id)

    li.append(done, ' ', text, ' ', del)
    list.append(li)
  }
}

todos.subscribeChanges(render, { includeInitialState: true })
