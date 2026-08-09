import { NavLink, Outlet, Navigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { SeoHead } from '../../seo/SeoHead'
import './app-shell.css'

export default function AppLayout() {
  const { user, ready, logout } = useAuth()

  if (!ready) return null
  if (!user) return <Navigate to="/login" replace state={{ from: '/app/agents' }} />

  return (
    <div className="shell">
      <SeoHead
        title="App — HireAlpha"
        description="Manage your HireAlpha agents and connectors."
        path="/app"
        noIndex
      />
      <aside className="shell__nav">
        <div className="shell__brand">
          <span className="shell__mark">α</span>
          <div>
            <strong>HireAlpha</strong>
            <small>{user.email}</small>
          </div>
        </div>

        <nav className="shell__links">
          <NavLink to="/app/agents" className={({ isActive }) => (isActive ? 'active' : '')}>
            Agents
          </NavLink>
          <NavLink to="/app/connectors" className={({ isActive }) => (isActive ? 'active' : '')}>
            Connectors
          </NavLink>
        </nav>

        <div className="shell__footer">
          <a href="/">Marketing site</a>
          <button type="button" onClick={logout}>
            Log out
          </button>
        </div>
      </aside>

      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  )
}
