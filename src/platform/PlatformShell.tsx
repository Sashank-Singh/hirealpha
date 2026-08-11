import { Link, NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom'
import { getSession, signOut } from './roster'

export function RequireAuth() {
  const session = getSession()
  if (!session) return <Navigate to="/app/login" replace />
  return <Outlet />
}

export function PlatformShell() {
  const session = getSession()
  const navigate = useNavigate()

  return (
    <div className="plat">
      <header className="plat__top">
        <div className="plat__top-inner">
          <Link to="/app" className="plat__brand">
            HireAlpha
          </Link>
          <nav className="plat__nav" aria-label="Workspace">
            <NavLink to="/app" end>
              Roster
            </NavLink>
            <NavLink to="/app/shop">Hire</NavLink>
          </nav>
          <div className="plat__user">
            <span className="plat__email">{session?.email}</span>
            <button
              type="button"
              className="plat-link"
              onClick={() => {
                signOut()
                navigate('/app/login')
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="plat__main">
        <Outlet />
      </main>
    </div>
  )
}
