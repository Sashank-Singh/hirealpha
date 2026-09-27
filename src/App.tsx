import { Component, lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { NotFoundPage, TrustPage } from './TrustPage'
import { alphaThreadHref } from './platform/alphaLine'
import { LAB_ROUTES } from './lab/labRoutes'

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
    const isChunkError = /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|chunkloaderror/i.test(
      error?.message || '',
    )
    if (isChunkError) {
      const key = 'ha_chunk_reload_ts'
      const last = sessionStorage.getItem(key)
      const now = Date.now()
      if (!last || now - Number(last) > 10000) {
        sessionStorage.setItem(key, String(now))
        window.location.reload()
      }
    }
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
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
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
            <a
              href={alphaThreadHref()}
              style={{
                background: '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                padding: '8px 18px',
                fontSize: '13px',
                fontWeight: 600,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              Return to iMessage
            </a>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

const Landing = lazy(() => import('./Landing'))
const MiniAppPage = lazy(() => import('./platform/MiniAppPage').then((m) => ({ default: m.MiniAppPage })))
const LoginPage = lazy(() => import('./platform/LoginPage').then((m) => ({ default: m.LoginPage })))
const RequireAuth = lazy(() => {
  // Start the app download while its independent session check is loading.
  void import('./platform/WorkspaceShell').catch(() => undefined)
  return import('./platform/PlatformShell').then(m => ({ default: m.RequireAuth }))
})
const WorkspaceShell = lazy(() => import('./platform/WorkspaceShell').then((m) => ({ default: m.WorkspaceShell })))
const VaultCapturePage = lazy(() => import('./platform/VaultCapturePage').then((m) => ({ default: m.VaultCapturePage })))
const ComputerSessionView = lazy(() => import('./platform/ComputerSessionView').then((m) => ({ default: m.ComputerSessionView })))
const TextAlphaPage = lazy(() => import('./platform/TextAlphaPage').then((m) => ({ default: m.TextAlphaPage })))

/* Alpha email prototype: the morning brief. Mock data only — it never calls the
 * API and nothing in the product UI links here. */
const LabEmailBrief = lazy(() => import('./lab/EmailBrief').then((m) => ({ default: m.EmailBriefPage })))

/* Old deep-link paths that still come in from texts and chat links —
 * they all land on the workspace shell, preserving query params. */
function AppRedirect() {
  const { search } = useLocation()
  return <Navigate to={`/app${search}`} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Suspense fallback={<div className="route-boot" role="status" aria-label="Loading Alpha" />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/x" element={<Landing />} />
            <Route path="/app/login" element={<LoginPage />} />
            <Route path="/privacy" element={<TrustPage kind="privacy" />} />
            <Route path="/terms" element={<TrustPage kind="terms" />} />
            <Route path="/computer/:sessionId" element={<ComputerSessionView />} />
            <Route path="/computer" element={<ComputerSessionView />} />
            <Route path="/app/mini/:persona/:kind" element={<MiniAppPage />} />
            {/* Alpha email prototype (mock data). Old concept paths redirect. */}
            <Route path={LAB_ROUTES.brief} element={<LabEmailBrief />} />
            {LAB_ROUTES.legacy.map((p) => (
              <Route key={p} path={p} element={<Navigate to={LAB_ROUTES.brief} replace />} />
            ))}
            {/* Where the wizard ends: one button to the Alpha thread, then the
             * platform. Kept outside RequireAuth so a slow session read can
             * never leave a freshly onboarded person staring at a spinner. */}
            <Route path="/app/text-alpha" element={<TextAlphaPage />} />
            <Route path="/app" element={<RequireAuth />}>
              <Route index element={<WorkspaceShell />} />
              <Route path="vault-login" element={<VaultCapturePage />} />
              {/* Redirect every old sub-route back to /app */}
              <Route path="*" element={<AppRedirect />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
