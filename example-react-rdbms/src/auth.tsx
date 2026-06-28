// A tiny auth context: it tracks whether you're "logged in" and holds the token
// the client sends on writes. That's it — no interception, no retry. The app
// reads `loggedIn` to label its login button, mutations go out with whatever
// token is set, and a rejected write surfaces as an error in the app.

import { createContext, useContext, useState, type ReactNode } from 'react'

// The token partyTransport sends as `Authorization: Bearer <token>`. It lives at
// module scope because the transport is built before React mounts and reads it
// via getToken; login()/logout() below set it.
let token: string | undefined
export const getToken = () => token

type Auth = { loggedIn: boolean; login: (password: string) => void; logout: () => void }
const AuthContext = createContext<Auth | null>(null)

export function useAuth(): Auth {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loggedIn, setLoggedIn] = useState(false)
  // login just stashes the token; the server is what actually validates it on the
  // next write (a wrong password → 401 → the app shows the error).
  const login = (password: string) => {
    token = password
    setLoggedIn(true)
  }
  const logout = () => {
    token = undefined
    setLoggedIn(false)
  }
  return <AuthContext value={{ loggedIn, login, logout }}>{children}</AuthContext>
}
