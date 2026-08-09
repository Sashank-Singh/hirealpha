import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import Landing from './pages/Landing'
import Login from './pages/Login'
import AppLayout from './pages/app/AppLayout'
import AgentsPage from './pages/app/AgentsPage'
import ConnectorsPage from './pages/app/ConnectorsPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/app" element={<AppLayout />}>
            <Route index element={<Navigate to="agents" replace />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="connectors" element={<ConnectorsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
