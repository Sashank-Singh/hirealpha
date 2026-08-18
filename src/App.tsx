import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Landing from './Landing'
import { FeaturesPage } from './platform/FeaturesPage'
import { HireConfigPage } from './platform/HireConfigPage'
import { HiresPage, ShopPage } from './platform/HiresPage'
import { LoginPage } from './platform/LoginPage'
import { LocationPage } from './platform/LocationPage'
import { MiniAppPage } from './platform/MiniAppPage'
import { OnboardingPage } from './platform/OnboardingPage'
import { PlatformShell, RequireAuth } from './platform/PlatformShell'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app/login" element={<LoginPage />} />
        <Route path="/app/mini/:persona/:kind" element={<MiniAppPage />} />
        <Route path="/app" element={<RequireAuth />}>
          <Route element={<PlatformShell />}>
            <Route index element={<HiresPage />} />
            <Route path="setup" element={<OnboardingPage />} />
            <Route path="shop" element={<ShopPage />} />
            <Route path="hires/:agentId" element={<HireConfigPage />} />
            <Route path="features" element={<FeaturesPage />} />
            <Route path="location" element={<LocationPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
