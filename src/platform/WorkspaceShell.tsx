import { useMemo, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getSession, signOut } from './roster'
import { SettingsSheet, type SettingsView } from './SettingsSheet'
import { paramsForWorkspaceView, workspaceViewFromParams } from './workspaceNavigation'
import './workspaceShell.css'

const views: Array<{
  id: SettingsView
  label: string
  description: string
  icon: ReactNode
}> = [
  {
    id: 'workspace',
    label: 'Workspace',
    description: 'Current tools, routines, and memory',
    icon: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5A1.5 1.5 0 0 1 12 5.5V9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5.5Zm0 9A1.5 1.5 0 0 1 5.5 13H11a1 1 0 0 1 1 1v4.5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 18.5v-4Zm11-9A1.5 1.5 0 0 1 16.5 4h2A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-2a1.5 1.5 0 0 1-1.5-1.5v-13Z" />,
  },
  {
    id: 'vault',
    label: 'Vault',
    description: 'Passwords and access grants',
    icon: <path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm7 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Zm-7-4v11.6M19 8v2M19 14v2" />,
  },
  {
    id: 'payments',
    label: 'Payments',
    description: 'Link wallet and purchase approvals',
    icon: <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 3h18M7 15h4" />,
  },
]

export function WorkspaceShell() {
  const [params, setParams] = useSearchParams()
  const session = getSession()
  const activeView = useMemo<SettingsView>(() => workspaceViewFromParams(params), [params])
  const active = views.find((view) => view.id === activeView)!

  function selectView(view: SettingsView) {
    setParams(paramsForWorkspaceView(params, view), { replace: true })
  }

  function logout() {
    signOut()
    window.location.assign('/app/login')
  }

  return (
    <div className="workspace-shell">
      <a className="workspace-skip" href="#workspace-main">Skip to content</a>
      <aside className="workspace-sidebar" aria-label="Product navigation">
        <a className="workspace-brand" href="/app" aria-label="HireAlpha home">
          <img src="/HireAlpha_logo.png" alt="" />
          <span>HireAlpha</span>
        </a>

        <nav className="workspace-nav">
          <p className="workspace-nav-label">Your space</p>
          {views.map((view) => (
            <button
              key={view.id}
              type="button"
              className={`workspace-nav-item${view.id === activeView ? ' is-active' : ''}`}
              aria-current={view.id === activeView ? 'page' : undefined}
              onClick={() => selectView(view.id)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">{view.icon}</svg>
              <span>
                <strong>{view.label}</strong>
                <small>{view.description}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="workspace-account">
          <span className="workspace-account-avatar" aria-hidden="true">
            {(session?.name || session?.email || 'A').slice(0, 1).toUpperCase()}
          </span>
          <span className="workspace-account-copy">
            <strong>{session?.name || 'Your account'}</strong>
            <small>{session?.email || 'Signed in'}</small>
          </span>
          <button type="button" onClick={logout}>Exit</button>
        </div>
      </aside>

      <main className="workspace-main" id="workspace-main">
        <header className="workspace-header">
          <div>
            <p>HireAlpha / {active.label}</p>
            <h1>{active.label}</h1>
          </div>
          <a href="sms:+14155951440&body=Hey%2C%20Alpha!">Message Alpha</a>
        </header>
        <div className="workspace-content">
          <SettingsSheet view={activeView} embedded />
        </div>
      </main>

      <nav className="workspace-mobile-nav" aria-label="Product navigation">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            className={view.id === activeView ? 'is-active' : ''}
            aria-current={view.id === activeView ? 'page' : undefined}
            onClick={() => selectView(view.id)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">{view.icon}</svg>
            <span>{view.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
