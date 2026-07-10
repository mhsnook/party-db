import { useState } from 'react'
import type { Collection } from '@tanstack/db'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { createPartyDb, partyTransport, WriteError } from '../../src/client/index.ts'
import { collections, type Language, type Phrase, type Deck, type Flashcard } from './collections.ts'
import { AuthProvider, useAuth, getAccessToken } from './auth.tsx'

// ✅ the entire party-db setup: a transport + the SAME shared `collections`.
const transport = partyTransport({ host: location.host, room: 'polyglot', token: getAccessToken })
export const { db } = createPartyDb(transport, collections)

// Re-assert row types only because this app lives inside the library's repo (two
// copies of @tanstack/db). In normal usage `db.public_phrases` is already typed.
const languages = db.public_languages as unknown as Collection<Language, string>
const phrases = db.public_phrases as unknown as Collection<Phrase, string>
const decks = db.user_decks as unknown as Collection<Deck, string>
const flashcards = db.user_flashcards as unknown as Collection<Flashcard, string>

// surface a rejected write instead of a silent rollback
function useWriteError() {
  const [error, setError] = useState<string | null>(null)
  const run = (tx: { isPersisted: { promise: Promise<unknown> } }) => {
    setError(null)
    tx.isPersisted.promise.catch((e: unknown) => {
      if (e instanceof WriteError && e.status === 401) setError('Log in to save your progress.')
      else if (e instanceof WriteError && e.status === 403) setError("That's not yours to edit.")
      else setError(e instanceof Error ? e.message : 'Write failed.')
    })
  }
  return { error, run }
}

function LoginBar() {
  const { me, login, logout } = useAuth()
  const [name, setName] = useState('')
  if (me)
    return (
      <p className="auth">
        👤 <strong>{me.name}</strong> · <button onClick={logout}>log out</button>
      </p>
    )
  return (
    <form
      className="auth"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) login(name)
        setName('')
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="your name — becomes your uid" />
      <button type="submit">log in</button>
    </form>
  )
}

// The catalog is public read; adding a phrase is `insert: 'authed'` — gated on
// being logged in. (🚧 the server won't enforce that yet; the UI models it.)
function AddPhrase({ languageId }: { languageId: string }) {
  const { me } = useAuth()
  const { error, run } = useWriteError()
  const [text, setText] = useState('')
  const [translation, setTranslation] = useState('')
  if (!me) return <p className="hint">Log in to contribute a phrase to the public catalog.</p>
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim() || !translation.trim()) return
          run(phrases.insert({ id: crypto.randomUUID(), language_id: languageId, text: text.trim(), translation: translation.trim() }))
          setText('')
          setTranslation('')
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="phrase" />
        <input value={translation} onChange={(e) => setTranslation(e.target.value)} placeholder="translation" />
        <button type="submit">+ add</button>
      </form>
      {error && <p className="error">{error}</p>}
    </>
  )
}

// Your settings for this language — a private write to your own deck.
function DeckSettings({ languageId }: { languageId: string }) {
  const { me } = useAuth()
  const { error, run } = useWriteError()
  const { data: deckRows } = useLiveQuery((q) => q.from({ deck: decks }).where(({ deck }) => eq(deck.language_id, languageId)))
  const deck = deckRows[0]

  if (!me) return null
  if (!deck)
    return (
      <button
        className="start"
        onClick={() =>
          run(decks.insert({ id: crypto.randomUUID(), user_id: me.id, language_id: languageId, daily_goal: 20, direction: 'recognize' }))
        }
      >
        Start learning this language
      </button>
    )

  return (
    <div className="deck">
      <label>
        daily goal
        <input
          type="number"
          min={1}
          value={deck.daily_goal}
          onChange={(e) => run(decks.update(deck.id, (d) => void (d.daily_goal = Number(e.target.value))))}
        />
      </label>
      <label>
        direction
        <select value={deck.direction} onChange={(e) => run(decks.update(deck.id, (d) => void (d.direction = e.target.value as Deck['direction'])))}>
          <option value="recognize">recognize</option>
          <option value="produce">produce</option>
        </select>
      </label>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

// The public phrases + YOUR status overlaid — one leftJoin across a public
// collection and a private one. The private side only ever reaches its owner, so
// the join can't leak someone else's progress (🚧 once enforcement lands).
function Phrases({ languageId }: { languageId: string }) {
  const { me } = useAuth()
  const { error, run } = useWriteError()
  const { data: cards } = useLiveQuery((q) =>
    q
      .from({ phrase: phrases })
      .where(({ phrase }) => eq(phrase.language_id, languageId))
      .leftJoin({ card: flashcards }, ({ phrase, card }) => eq(card.phrase_id, phrase.id))
      .orderBy(({ phrase }) => phrase.id, 'asc')
      .select(({ phrase, card }) => ({
        id: phrase.id,
        text: phrase.text,
        translation: phrase.translation,
        status: card?.status ?? 'new',
        cardId: card?.id,
      })),
  )

  // user_id is passed explicitly today; once the framework auto-stamps the owner
  // column from your uid (cookbook 05), this becomes just { id, phrase_id, ... }.
  const learn = (phraseId: string) =>
    run(flashcards.insert({ id: crypto.randomUUID(), user_id: me!.id, phrase_id: phraseId, status: 'learning', due_at: Date.now() }))
  const promote = (cardId: string) => run(flashcards.update(cardId, (c) => void (c.status = 'known')))

  return (
    <>
      <ul>
        {cards.map((c) => (
          <li key={c.id} data-status={c.status}>
            <span>
              <strong>{c.text}</strong> — {c.translation}
            </span>
            <em className="status">{c.status}</em>
            {me &&
              (c.status === 'new' ? (
                <button onClick={() => learn(c.id)}>+ deck</button>
              ) : c.status === 'learning' && c.cardId ? (
                <button onClick={() => promote(c.cardId!)}>✓ known</button>
              ) : null)}
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </>
  )
}

function Polyglot() {
  const { data: langs } = useLiveQuery((q) => q.from({ l: languages }).orderBy(({ l }) => l.name, 'asc'))
  const [languageId, setLanguageId] = useState<string | null>(null)
  const active = languageId ?? langs[0]?.id ?? null

  return (
    <>
      <h1>party-db · polyglot</h1>
      <p className="sub">
        A public catalog everyone shares (<code>public_languages</code>, <code>public_phrases</code>) plus per-user{' '}
        <code>user_decks</code> and <code>user_flashcards</code>.
      </p>
      <p className="flag">
        🚧 <strong>Speculative.</strong> The <code>access</code>/<code>owner</code>/<code>auth</code> rules are declared but the
        framework doesn&apos;t enforce them yet — so right now every collection syncs publicly. See the README.
      </p>

      <LoginBar />

      <nav className="langs">
        {langs.map((l) => (
          <button key={l.id} className={l.id === active ? 'on' : ''} onClick={() => setLanguageId(l.id)}>
            {l.flag} {l.name}
          </button>
        ))}
      </nav>

      {active && (
        <>
          <DeckSettings languageId={active} />
          <Phrases languageId={active} />
          <hr />
          <AddPhrase languageId={active} />
        </>
      )}

      <footer>
        Synced with <strong>party-db</strong> ·{' '}
        <a href="https://github.com/mhsnook/party-db" target="_blank" rel="noopener">
          see the code →
        </a>
      </footer>
    </>
  )
}

export function App() {
  return (
    <AuthProvider>
      <Polyglot />
    </AuthProvider>
  )
}
