// A tiny identity context. Real apps hand the transport a JWT and the server
// verifies it (cookbook 05 / recipe 3); here we keep it demo-simple: "logging in"
// is just typing a name, which becomes your uid. The transport sends that uid as
// the token, and the server's `auth` reads it back (token === uid, no JWKS).
//
// The server pins a socket's uid when the socket connects, so switching identity
// has to reconnect: login() and logout() set the token, then call `onSwitch`,
// which resets the party db. The new socket connects as the new user, and the
// server hands it only that user's decks and flashcards.

import { createContext, useContext, useState, type ReactNode } from 'react'

// The token partyTransport sends. Module scope because the transport is built
// before React mounts and reads it via getAccessToken; kept in this tab's
// sessionStorage so a reload stays signed in.
const TOKEN_KEY = 'polyglot:token'
let token = sessionStorage.getItem(TOKEN_KEY) ?? undefined
export const getAccessToken = () => token

const meOf = (id: string | undefined): Me | null => (id ? { id, name: id.replace(/^user:/, '') } : null)

export type Me = { id: string; name: string }
type Auth = { me: Me | null; login: (name: string) => void; logout: () => void }
const AuthContext = createContext<Auth | null>(null)

export function useAuth(): Auth {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function AuthProvider({ children, onSwitch }: { children: ReactNode; onSwitch: () => void }) {
  const [me, setMe] = useState<Me | null>(() => meOf(token))
  const become = (next: string | undefined) => {
    token = next
    if (next) sessionStorage.setItem(TOKEN_KEY, next)
    else sessionStorage.removeItem(TOKEN_KEY)
    setMe(meOf(next))
    onSwitch()
  }
  const login = (name: string) => become(`user:${name.trim().toLowerCase().replace(/\s+/g, '-')}`)
  const logout = () => become(undefined)
  return <AuthContext value={{ me, login, logout }}>{children}</AuthContext>
}
