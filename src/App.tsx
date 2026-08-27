import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

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
const PlatformShell = lazy(() => import('./platform/PlatformShell').then((m) => ({ default: m.PlatformShell })))
const HiresPage = lazy(() => import('./platform/HiresPage').then((m) => ({ default: m.HiresPage })))
const ShopPage = lazy(() => import('./platform/HiresPage').then((m) => ({ default: m.ShopPage })))
const HireConfigPage = lazy(() => import('./platform/HireConfigPage').then((m) => ({ default: m.HireConfigPage })))
const FeaturesPage = lazy(() => import('./platform/FeaturesPage').then((m) => ({ default: m.FeaturesPage })))
const LocationPage = lazy(() => import('./platform/LocationPage').then((m) => ({ default: m.LocationPage })))
const ControlsPage = lazy(() => import('./marketing/ControlsPage').then((m) => ({ default: m.ControlsPage })))

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
            <Route element={<PlatformShell />}>
              <Route index element={<HiresPage />} />
              <Route path="shop" element={<ShopPage />} />
              <Route path="hires/:agentId" element={<HireConfigPage />} />
              <Route path="features" element={<FeaturesPage />} />
              <Route path="location" element={<LocationPage />} />
            </Route>
            <Route path="controls" element={<ControlsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
