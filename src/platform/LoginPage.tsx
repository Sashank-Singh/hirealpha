import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { apiExchangeGoogle, apiSignIn } from './api'
import { getSession, hydrateFromServer, signIn } from './roster'

export function LoginPage() {
  const existing = getSession()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [name, setName] = useState(existing?.name || '')
  const [email, setEmail] = useState(existing?.email || '')
  const [phone, setPhone] = useState(existing?.phone || '')
  const [emailMode, setEmailMode] = useState(!!existing?.email && !existing?.phone)
  const [googleUser, setGoogleUser] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const err = params.get('error')
    const ticket = params.get('google')
    if (err === 'google') {
      setError('Google sign in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on HireAlpha-Web.')
      setParams({}, { replace: true })
      return
    }
    if (!ticket) return
    setBusy(true)
    void apiExchangeGoogle(ticket)
      .then(async (data) => {
        setEmail(data.email)
        if (data.name) setName(data.name)
        setGoogleUser(true)
        if (data.phone) {
          signIn(data.email, data.phone, data.name)
          await hydrateFromServer().catch(() => undefined)
          navigate('/app')
          return
        }
        setEmailMode(true)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Google sign in failed')
      })
      .finally(() => {
        setBusy(false)
        setParams({}, { replace: true })
      })
  }, [navigate, params, setParams])

  if (existing?.email && existing.phone) return <Navigate to="/app" replace />

  async function finish(nextName: string, nextEmail: string, nextPhone: string) {
    setBusy(true)
    setError('')
    try {
      await apiSignIn(nextEmail, nextPhone, nextName)
      signIn(nextEmail, nextPhone, nextName)
      await hydrateFromServer().catch(() => undefined)
      navigate('/app')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  function onGoogle() {
    window.location.href = '/api/auth/google'
  }

  function onEmailSubmit(e: FormEvent) {
    e.preventDefault()
    const nextName = name.trim()
    const nextEmail = email.trim().toLowerCase()
    const nextPhone = phone.trim()
    if (!nextName) {
      setError('What should they call you?')
      return
    }
    if (!nextEmail || !nextEmail.includes('@')) {
      setError('Enter a valid email.')
      return
    }
    if (nextPhone.replace(/\D/g, '').length < 10) {
      setError('Enter the phone you text from in Messages, including area code.')
      return
    }
    void finish(nextName, nextEmail, nextPhone)
  }

  return (
    <div className="plat plat--auth">
      <div className="plat-auth">
        <p className="plat-auth__brand">HireAlpha</p>
        <h1>Sign in</h1>
        <p className="plat-auth__sub">
          {googleUser
            ? 'Google is in. Add your name and the phone you text the hires from so they can find you.'
            : 'Hire people for your texts, then connect what they need.'}
        </p>

        <div className="plat-auth__methods">
          {!googleUser && (
            <button type="button" className="plat-btn plat-btn--block" onClick={onGoogle} disabled={busy}>
              <GoogleMark />
              {busy ? 'Signing in…' : 'Continue with Google'}
            </button>
          )}

          {!emailMode && !googleUser ? (
            <button type="button" className="plat-link plat-link--center" onClick={() => setEmailMode(true)}>
              Use email instead
            </button>
          ) : (
            <form onSubmit={onEmailSubmit} className="plat-auth__form">
              <label>
                Your name
                <input
                  type="text"
                  required
                  autoComplete="name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (error) setError('')
                  }}
                  placeholder="Sashank"
                />
              </label>
              {!googleUser && (
                <label>
                  Email
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      if (error) setError('')
                    }}
                    placeholder="you@example.com"
                  />
                </label>
              )}
              <label>
                iMessage phone
                <input
                  type="tel"
                  required
                  autoFocus={googleUser}
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value)
                    if (error) setError('')
                  }}
                  placeholder="+1 216 303 2166"
                />
              </label>
              {error && <p className="plat-auth__error">{error}</p>}
              <button type="submit" className="plat-btn plat-btn--block" disabled={busy}>
                {busy ? 'Signing in…' : googleUser ? 'Save and continue' : 'Continue with email'}
              </button>
            </form>
          )}
        </div>

        {error && !emailMode && !googleUser && <p className="plat-auth__error">{error}</p>}

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
