import { createPartyDb, partyTransport, definePartyCollection } from '../../src/client/index.ts'
import { todoSchema, type Todo } from './schema.ts'

const transport = partyTransport({ host: location.host, room: 'demo' })
const { db } = createPartyDb(transport, [
  definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema }),
])
const todos = db.todos

const form = document.getElementById('form') as HTMLFormElement
const input = document.getElementById('text') as HTMLInputElement
const list = document.getElementById('list') as HTMLUListElement

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text) return
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

// re-render on every committed change (incl. the initial synced snapshot).
todos.subscribeChanges(render, { includeInitialState: true })
