import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useState, type FormEvent } from 'react'
import { app } from './app'

export function App() {
  const { data: session, isPending } = app.auth.useSession()
  const userId = session?.user.id ?? null

  useEffect(() => {
    if (!isPending) app.setUser(userId)
  }, [isPending, userId])

  if (isPending) return <p>Loading…</p>
  if (!session) return <SignIn />
  return (
    <main>
      <header>
        <span>Signed in as {session.user.email}</span>{' '}
        <button onClick={() => app.auth.signOut()}>Sign out</button>
      </header>
      <Todos />
      <Files />
    </main>
  )
}

function SignIn() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const email = String(form.get('email'))
    const password = String(form.get('password'))
    const { error } =
      mode === 'sign-up'
        ? await app.auth.signUp.email({ email, password, name: email.split('@')[0]! })
        : await app.auth.signIn.email({ email, password })
    setError(error?.message ?? null)
  }

  return (
    <form onSubmit={submit}>
      <h1>{mode === 'sign-in' ? 'Sign in' : 'Create an account'}</h1>
      <input name="email" type="email" placeholder="Email" required />
      <input name="password" type="password" placeholder="Password" minLength={8} required />
      <button type="submit">{mode === 'sign-in' ? 'Sign in' : 'Create account'}</button>
      <button type="button" onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
        {mode === 'sign-in' ? 'I need an account' : 'I already have an account'}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

function Todos() {
  const { data: todos } = useLiveQuery((q) =>
    q.from({ t: app.db.todos }).orderBy(({ t }) => t.created_at),
  )

  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = e.currentTarget.elements.namedItem('text') as HTMLInputElement
    if (!input.value.trim()) return
    app.db.todos.insert({
      id: crypto.randomUUID(),
      text: input.value.trim(),
      done: false,
      created_at: new Date().toISOString(),
    })
    input.value = ''
  }

  return (
    <section>
      <h2>Todos</h2>
      <form onSubmit={add}>
        <input name="text" placeholder="What needs doing?" />
        <button type="submit">Add todo</button>
      </form>
      <ul>
        {todos.map((t) => (
          <li key={t.id}>
            <label>
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => app.db.todos.update(t.id, (d) => void (d.done = !d.done))}
              />
              {t.text}
            </label>{' '}
            <button onClick={() => app.db.todos.delete(t.id)}>Delete todo</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Files() {
  const { data: files } = useLiveQuery((q) =>
    q.from({ f: app.db.files }).orderBy(({ f }) => f.created_at),
  )
  const [busy, setBusy] = useState(false)

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      await app.storage.upload(file)
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  return (
    <section>
      <h2>Files</h2>
      <input type="file" onChange={pick} disabled={busy} />
      <ul>
        {files.map((f) => (
          <li key={f.id}>
            {f.content_type.startsWith('image/') && (
              <img src={app.storage.imageUrl(f.id, 160)} alt={f.name} width={160} />
            )}
            <a href={`/api/files/${f.id}/content`}>{f.name}</a> ({f.size} bytes){' '}
            <button onClick={() => app.db.files.delete(f.id)}>Delete file</button>
          </li>
        ))}
      </ul>
    </section>
  )
}
