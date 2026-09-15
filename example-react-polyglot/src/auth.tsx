// A tiny identity context. Real apps hand the transport a JWT and the server
// verifies it (cookbook 05 / recipe 3); here we keep it demo-simple: "logging in"
// is just typing a name, which becomes your uid. The transport sends that uid as
// the token, and the server's `auth` reads it back (token === uid, no JWKS).
//
// The server pins a socket's uid when the socket connects, so switching identity
// has to reconnect: login() and logout() store the token for this tab and reload.
// The new socket connects as the new user, and the server hands it only that
// user's decks and flashcards.

import { createContext, useContext, useState, type ReactNode } from 'react'

// The token partyTransport sends. Module scope because the transport is built
// before React mounts and reads it via getAccessToken; it survives the reload
// login()/logout() do, in this tab's sessionStorage.
const TOKEN_KEY = 'polyglot:token'
const token = sessionStorage.getItem(TOKEN_KEY) ?? undefined
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me] = useState<Me | null>(() => meOf(token))
  const login = (name: string) => {
    sessionStorage.setItem(TOKEN_KEY, `user:${name.trim().toLowerCase().replace(/\s+/g, '-')}`)
    location.reload()
  }
  const logout = () => {
    sessionStorage.removeItem(TOKEN_KEY)
    location.reload()
  }
  return <AuthContext value={{ me, login, logout }}>{children}</AuthContext>
}
