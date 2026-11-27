import { BrowserHost } from '@effect/ui/html'
import { Effect, Layer } from 'effect'
import { TodoList } from './components/TodoList.ts'

const Main = BrowserHost.mount(TodoList, {}, document.getElementById('app')!)

Layer.launch(Main).pipe(Effect.runFork)
