import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const key = 'ha_chunk_reload_ts'
  const last = sessionStorage.getItem(key)
  const now = Date.now()
  if (!last || now - Number(last) > 10000) {
    sessionStorage.setItem(key, String(now))
    window.location.reload()
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
