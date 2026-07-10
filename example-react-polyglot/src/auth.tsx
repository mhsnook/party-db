// A tiny identity context. Real apps hand the transport a JWT and the server
// verifies it (cookbook 05 / recipe 3); here we keep it demo-simple: "logging in"
// is just typing a name, which becomes your uid. The transport sends that uid as
// the token, and the server's `auth` reads it back (token === uid, no JWKS).
//
// 🚧 Enforcement of owner/access rules is unbuilt, so switching identity does NOT
// (yet) hide another learner's decks/flashcards. It's here to show the intended
// UX and where identity plugs in.

import { createContext, useContext, useState, type ReactNode } from 'react'

// The token partyTransport sends. Module scope because the transport is built
// before React mounts and reads it via getAccessToken; login()/logout() set it.
let token: string | undefined
export const getAccessToken = () => token

export type Me = { id: string; name: string }
type Auth = { me: Me | null; login: (name: string) => void; logout: () => void }
const AuthContext = createContext<Auth | null>(null)

export function useAuth(): Auth {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const login = (name: string) => {
    const id = `user:${name.trim().toLowerCase().replace(/\s+/g, '-')}`
    token = id
    setMe({ id, name: name.trim() })
  }
  const logout = () => {
    token = undefined
    setMe(null)
  }
  return <AuthContext value={{ me, login, logout }}>{children}</AuthContext>
}
