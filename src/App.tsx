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
          background: '#111111',
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
              background: '#2a2a2a',
              color: '#ffffff',
              border: '1px solid #444',
              borderRadius: '8px',
              padding: '8px 18px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const Landing = lazy(() => import('./Landing'))
const MiniAppPage = lazy(() => import('./platform/MiniAppPage').then((m) => ({ default: m.MiniAppPage })))
const LoginPage = lazy(() => import('./platform/LoginPage').then((m) => ({ default: m.LoginPage })))
const RequireAuth = lazy(() => import('./platform/PlatformShell').then((m) => ({ default: m.RequireAuth })))
const SettingsSheet = lazy(() => import('./platform/SettingsSheet').then((m) => ({ default: m.SettingsSheet })))

/* Old deep-link paths that still come in from texts and chat links —
 * they all land on /app which renders SettingsSheet, preserving query params. */
function AppRedirect() {
  const { search } = useLocation()
  return <Navigate to={`/app${search}`} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Suspense fallback={<div className="route-boot" />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/app/login" element={<LoginPage />} />
            <Route path="/app/mini/:persona/:kind" element={<MiniAppPage />} />
            <Route path="/app" element={<RequireAuth />}>
              {/* SettingsSheet is the whole authenticated app */}
              <Route index element={<SettingsSheet />} />
              {/* Redirect every old sub-route back to /app */}
              <Route path="*" element={<AppRedirect />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
