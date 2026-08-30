import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'

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
const PhoneApp = lazy(() => import('./platform/PhoneApp').then((m) => ({ default: m.PhoneApp })))
const SettingsSheet = lazy(() => import('./platform/SettingsSheet').then((m) => ({ default: m.SettingsSheet })))

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
      <Suspense fallback={<div className="route-boot" />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/app/login" element={<LoginPage />} />
          <Route path="/app/mini/:persona/:kind" element={<MiniAppPage />} />
          <Route path="/app" element={<RequireAuth />}>
            <Route index element={<PhoneApp />} />
            <Route path="settings" element={<SettingsSheet />} />
            <Route path="shop" element={<Navigate to="/app" replace />} />
            <Route path="hires/:agentId" element={<SettingsRedirect />} />
            <Route path="features" element={<Navigate to="/app" replace />} />
            <Route path="location" element={<SettingsRedirect />} />
            <Route path="controls" element={<SettingsRedirect />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
