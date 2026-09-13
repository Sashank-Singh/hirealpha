import { Navigate, Outlet, useSearchParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { getSession, signIn, signOut } from './roster'

/* Signed-in gate with both identifiers: the email names the account and the
 * phone is what the bots resolve against. Missing either means the session is
 * half-built, so back to login to finish it. Supports authenticated token links
 * (?t=... / ?token=...) from iMessage without forcing a manual email/password login. */
export function RequireAuth() {
  const [session, setSession] = useState(() => getSession())
  const [verified, setVerified] = useState<boolean | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [searchParams] = useSearchParams()
  const token = searchParams.get('t') || searchParams.get('token') || ''

  useEffect(() => {
    let active = true
    const sessionUrl = token ? `/api/auth/session?t=${encodeURIComponent(token)}` : '/api/auth/session'
    fetch(sessionUrl)
      .then(async (res) => {
        if (!active) return
        if (res.status === 401 || res.status === 403) {
          if (!token) signOut()
          setVerified(false)
        } else if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            email?: string
            phone?: string
            name?: string
            timezone?: string
          }
          if (data.email) {
            const s = signIn(data.email, data.phone || session?.phone || '', data.name, data.timezone)
            setSession(s)
          }
          setVerified(true)
        } else {
          setUnavailable(true)
        }
      })
      .catch(() => {
        if (active) setUnavailable(true)
      })
    return () => {
      active = false
    }
  }, [token])

  if (!session?.email && !token) return <Navigate to="/app/login" replace />
  if (!session?.phone && !token && verified !== true) return <Navigate to="/app/login" replace />
  if (verified === false) return <Navigate to="/app/login" replace />
  if (unavailable) return <p>Could not check your session. <button onClick={() => window.location.reload()}>Try again</button></p>
  if (!verified) return <p>Checking your session…</p>
  return <Outlet />
}
