import { Component, lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[App ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#09090c',
          color: '#f4f4f6',
          fontFamily: 'system-ui, sans-serif',
          padding: '24px',
          textAlign: 'center',
        }}>
          <h2 style={{ fontSize: '20px', marginBottom: '12px', color: '#ffffff' }}>Something went wrong loading this view</h2>
          <p style={{ color: '#8b8d9e', fontSize: '13px', maxWidth: '460px', marginBottom: '20px' }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            type="button"
            style={{
              background: '#2a6f7a',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              padding: '8px 18px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={() => window.location.reload()}
          >
            Reload Console
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/* Every route used to sit in one 630 kB bundle, so a phone opening a mini app
 * from a text downloaded the marketing page's animation library (133 kB) and
 * the whole dashboard before it could paint. Each route now fetches its own
 * chunk, and the server sends a `modulepreload` for the chunk the URL asks for
 * (see `preloadTags` in deploy/web-server.ts), so the split does not cost a
 * round trip — the route chunk and the entry chunk download together. */
const Landing = lazy(() => import('./Landing'))
const MiniAppPage = lazy(() => import('./platform/MiniAppPage').then((m) => ({ default: m.MiniAppPage })))
const LoginPage = lazy(() => import('./platform/LoginPage').then((m) => ({ default: m.LoginPage })))
const RequireAuth = lazy(() => import('./platform/PlatformShell').then((m) => ({ default: m.RequireAuth })))
const PlatformDashboard = lazy(() => import('./platform/PlatformDashboard').then((m) => ({ default: m.PlatformDashboard })))

/* Old dashboard routes deep-link from texts and chat (hirealpha.chat/app/hires/
 * friend?connect=gmail). They land on Settings carrying their query so the
 * connector highlight still fires. */
function SettingsRedirect() {
  const { search } = useLocation()
  return <Navigate to={`/app/settings${search}`} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      {/* Deliberately blank rather than a spinner: the served HTML already sets
        * the right background for the route, so the hold reads as the page
        * before paint instead of a flash of something else. */}
      <ErrorBoundary>
        <Suspense fallback={<div className="route-boot" />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/app/login" element={<LoginPage />} />
            <Route path="/app/mini/:persona/:kind" element={<MiniAppPage />} />
            <Route path="/app" element={<RequireAuth />}>
              <Route index element={<PlatformDashboard />} />
              <Route path="requests" element={<PlatformDashboard />} />
              <Route path="tools" element={<PlatformDashboard />} />
              <Route path="loops" element={<PlatformDashboard />} />
              <Route path="intel" element={<PlatformDashboard />} />
              <Route path="settings" element={<PlatformDashboard />} />
              <Route path="shop" element={<Navigate to="/app" replace />} />
              <Route path="hires/:agentId" element={<SettingsRedirect />} />
              <Route path="features" element={<Navigate to="/app" replace />} />
              <Route path="location" element={<SettingsRedirect />} />
              <Route path="controls" element={<SettingsRedirect />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
