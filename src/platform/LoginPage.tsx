import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ensureConnectorUser } from './api'
import { getSession, signIn } from './roster'

export function LoginPage() {
  const existing = getSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [emailMode, setEmailMode] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (existing) return <Navigate to="/app" replace />

  async function finish(nextEmail: string) {
    setBusy(true)
    setError('')
    try {
      signIn(nextEmail)
      await ensureConnectorUser(nextEmail)
      navigate('/app')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed')
    } finally {
      setBusy(false)
    }
  }

  function onGoogle() {
    void finish('you@gmail.com')
  }

  function onEmailSubmit(e: FormEvent) {
    e.preventDefault()
    const value = email.trim().toLowerCase()
    if (!value || !value.includes('@')) {
      setError('Enter a valid email.')
      return
    }
    void finish(value)
  }

  return (
    <div className="plat plat--auth">
      <div className="plat-auth">
        <p className="plat-auth__brand">HireAlpha</p>
        <h1>Sign in</h1>
        <p className="plat-auth__sub">Connect tools and context for the people you hired.</p>

        <div className="plat-auth__methods">
          <button type="button" className="plat-btn plat-btn--block" onClick={onGoogle} disabled={busy}>
            <GoogleMark />
            Continue with Google
          </button>

          {!emailMode ? (
            <button type="button" className="plat-link plat-link--center" onClick={() => setEmailMode(true)} disabled={busy}>
              Use email instead
            </button>
          ) : (
            <form onSubmit={onEmailSubmit} className="plat-auth__form">
              <label>
                Email
                <input
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (error) setError('')
                  }}
                  placeholder="you@example.com"
                />
              </label>
              {error && <p className="plat-auth__error">{error}</p>}
              <button type="submit" className="plat-btn plat-btn--block" disabled={busy}>
                {busy ? 'Signing in…' : 'Continue with email'}
              </button>
            </form>
          )}
          {!emailMode && error && <p className="plat-auth__error">{error}</p>}
        </div>

        <p className="plat-auth__foot">
          <Link to="/" className="plat-link">
            Back to site
          </Link>
        </p>
      </div>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16.1 19 12 24 12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.1 26.8 36 24 36c-5.3 0-9.7-3.1-11.3-7.5l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l.1.1 6.2 5.2C39.2 37.1 44 32 44 24c0-1.3-.1-2.3-.4-3.5z"
      />
    </svg>
  )
}
