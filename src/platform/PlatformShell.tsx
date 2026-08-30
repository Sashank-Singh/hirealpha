import { Navigate, Outlet } from 'react-router-dom'
import { getSession } from './roster'

/* Signed-in gate with both identifiers: the email names the account and the
 * phone is what the bots resolve against. Missing either means the session is
 * half-built, so back to login to finish it. */
export function RequireAuth() {
  const session = getSession()
  if (!session?.email) return <Navigate to="/app/login" replace />
  if (!session.phone) return <Navigate to="/app/login" replace />
  return <Outlet />
}
