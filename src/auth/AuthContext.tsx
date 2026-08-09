import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export interface User {
  email: string
  name: string
}

interface AuthContextValue {
  user: User | null
  ready: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string, name?: string) => Promise<void>
  logout: () => void
}

const STORAGE_KEY = 'hirealpha-auth'
const AuthContext = createContext<AuthContextValue | null>(null)

function readUser(): User | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as User
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => readUser())
  const [ready] = useState(true)

  const persist = useCallback((next: User | null) => {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    else localStorage.removeItem(STORAGE_KEY)
    setUser(next)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const cleaned = email.trim().toLowerCase()
    if (!cleaned.includes('@') || password.length < 6) {
      throw new Error('Use a valid email and a password with at least 6 characters.')
    }
    // Client-side session for now. Swap this for a real auth API later.
    await new Promise((r) => setTimeout(r, 450))
    const name = cleaned.split('@')[0] || 'You'
    persist({ email: cleaned, name })
  }, [persist])

  const signup = useCallback(async (email: string, password: string, name?: string) => {
    const cleaned = email.trim().toLowerCase()
    if (!cleaned.includes('@') || password.length < 6) {
      throw new Error('Use a valid email and a password with at least 6 characters.')
    }
    await new Promise((r) => setTimeout(r, 450))
    persist({
      email: cleaned,
      name: (name?.trim() || cleaned.split('@')[0] || 'You'),
    })
  }, [persist])

  const logout = useCallback(() => persist(null), [persist])

  const value = useMemo(
    () => ({ user, ready, login, signup, logout }),
    [user, ready, login, signup, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
