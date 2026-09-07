import { Navigate, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { getSession, signOut } from './roster'

/* Signed-in gate with both identifiers: the email names the account and the
 * phone is what the bots resolve against. Missing either means the session is
 * half-built, so back to login to finish it. */
export function RequireAuth() {
  const session = getSession()
  const [verified, setVerified] = useState<boolean | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    let active = true
    fetch('/api/auth/session').then((res) => {
      if (!active) return
      if (res.status === 401 || res.status === 403) { signOut(); setVerified(false) }
      else if (res.ok) setVerified(true)
      else setUnavailable(true)
    }).catch(() => { if (active) setUnavailable(true) })
    return () => { active = false }
  }, [])
  if (!session?.email) return <Navigate to="/app/login" replace />
  if (!session.phone) return <Navigate to="/app/login" replace />
  if (verified === false) return <Navigate to="/app/login" replace />
  if (unavailable) return <p>Could not check your session. <button onClick={() => window.location.reload()}>Try again</button></p>
  if (!verified) return <p>Checking your session…</p>
  return <Outlet />
}
