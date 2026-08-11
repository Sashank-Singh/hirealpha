import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Landing from './Landing'
import { HireConfigPage } from './platform/HireConfigPage'
import { HiresPage, ShopPage } from './platform/HiresPage'
import { LoginPage } from './platform/LoginPage'
import { PlatformShell, RequireAuth } from './platform/PlatformShell'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app/login" element={<LoginPage />} />
        <Route path="/app" element={<RequireAuth />}>
          <Route element={<PlatformShell />}>
            <Route index element={<HiresPage />} />
            <Route path="shop" element={<ShopPage />} />
            <Route path="hires/:agentId" element={<HireConfigPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
