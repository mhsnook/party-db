import { Command, Component, Query, UiSchema } from '@effect/ui'
import { Html } from '@effect/ui/html'
import { Effect, Layer, Schema } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { Todo, WriteFailed } from '../domain/Todo.ts'
import { Todos } from '../services/Todos.ts'

export const TodoListMessage = UiSchema.TaggedEnum({
  UpdatedDraft: { text: Schema.String },
  SubmittedTodoForm: {},
  ToggledTodo: { id: Schema.String, done: Schema.Boolean },
  ClickedDelete: { id: Schema.String },
  FailedWriteTodo: { reason: Schema.String },
})

// Each element replaces the query's value, so the list lives in `h.queries`,
// never in the Model.
export class ListTodos extends Query.StreamService<ListTodos>()('todos/ListTodos', {
  success: Schema.Array(Todo),
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const todos = yield* Todos
      return () => todos.list
    }),
  )
}

export class AddTodo extends Command.Service<AddTodo>()('todos/AddTodo', {
  args: { text: Schema.String },
  success: Schema.Void,
  error: WriteFailed,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const todos = yield* Todos
      return ({ text }) => todos.add(text)
    }),
  )
}

export class SetTodoDone extends Command.Service<SetTodoDone>()('todos/SetTodoDone', {
  args: { id: Schema.String, done: Schema.Boolean },
  success: Schema.Void,
  error: WriteFailed,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const todos = yield* Todos
      return ({ id, done }) => todos.setDone(id, done)
    }),
  )
}

export class DeleteTodo extends Command.Service<DeleteTodo>()('todos/DeleteTodo', {
  args: { id: Schema.String },
  success: Schema.Void,
  error: WriteFailed,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const todos = yield* Todos
      return ({ id }) => todos.remove(id)
    }),
  )
}

// A write that succeeds sends nothing: its change already arrived through
// ListTodos. Only a refused write reaches `update`.
const reportRefusal = Command.match({
  onSuccess: () => Component.noop,
  onFailure: (error: WriteFailed) => TodoListMessage.FailedWriteTodo({ reason: error.reason }),
})

export const TodoListNoDeps = Html.component({
  name: 'TodoList',
  model: Schema.Struct({ draft: Schema.String, error: Schema.NullOr(Schema.String) }),
  message: TodoListMessage,
  queries: { todos: { query: ListTodos, args: () => ({}) } },
}).make({
  init: () => ({ draft: '', error: null }),
  update: {
    UpdatedDraft: ($, { text }) => $.evolve({ draft: text }),
    SubmittedTodoForm: ($) => {
      const text = $.model.draft.trim()
      return text === '' ? $.model : $.evolve({ draft: '', error: null }).run(AddTodo.make({ text }).pipe(reportRefusal))
    },
    ToggledTodo: ($, { id, done }) => $.evolve({ error: null }).run(SetTodoDone.make({ id, done }).pipe(reportRefusal)),
    ClickedDelete: ($, { id }) => $.evolve({ error: null }).run(DeleteTodo.make({ id }).pipe(reportRefusal)),
    FailedWriteTodo: ($, { reason }) => $.evolve({ error: reason }),
  },
  view: (h, model) =>
    h.div(
      h.form
        .attr('id', 'form')
        .on('submit', TodoListMessage.SubmittedTodoForm())
        .children(
          h.input
            .attrs({ id: 'text', placeholder: 'new todo', autocomplete: 'off' })
            .value(model.draft)
            .on('input', ({ value }) => TodoListMessage.UpdatedDraft({ text: value })),
          h.button.attr('type', 'submit').children('add'),
        ),
      model.error !== null && h.p.attr('role', 'alert').children(model.error),
      AsyncResult.match(h.queries.todos, {
        onInitial: () => h.p('Loading todos…'),
        onFailure: () => h.p("The todos couldn't be loaded."),
        onSuccess: ({ value: todos }) =>
          h.ul(
            todos.map((todo) =>
              h.li.key(todo.id).children(
                h.input
                  .attrs({ type: 'checkbox', 'aria-label': `Done: ${todo.text}` })
                  .checked(todo.done)
                  .on('change', ({ checked }) => TodoListMessage.ToggledTodo({ id: todo.id, done: checked })),
                h.span.class(todo.done && 'done').children(todo.text),
                h.button
                  .attrs({ type: 'button', 'aria-label': `Delete ${todo.text}` })
                  .on('click', TodoListMessage.ClickedDelete({ id: todo.id }))
                  .children('✕'),
              ),
            ),
          ),
      }),
    ),
})

// One Todos instance for the whole tree: the list query and the three commands
// share its socket.
export const TodoList = TodoListNoDeps.pipe(
  Component.provide(
    Layer.mergeAll(ListTodos.layer, AddTodo.layer, SetTodoDone.layer, DeleteTodo.layer).pipe(
      Layer.provide(Todos.layerParty),
    ),
  ),
)
