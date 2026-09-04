import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { apiExchangeGoogle, apiLoginPassword, apiRegisterPassword, apiSavePhone, apiSignIn } from './api'
import { getSession, hydrateFromServer, signIn } from './roster'

type AuthMode = 'signin' | 'signup'

export function LoginPage() {
  const existing = getSession()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const emailParam = params.get('email') || ''
  const planParam = params.get('plan') || ''
  const [mode, setMode] = useState<AuthMode>(existing?.name ? 'signin' : 'signup')
  const [name, setName] = useState(existing?.name || '')
  const [email, setEmail] = useState(existing?.email || emailParam)
  const [phone, setPhone] = useState(existing?.phone || '')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [googleUser, setGoogleUser] = useState(false)
  const [pwSignedIn, setPwSignedIn] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /** The moment auth completes the account goes to Stripe — always. A plan
   * picked on the pricing card is honored; otherwise the single-hire trial is
   * the default (7 days free, then $5 x 2 months, then $19). The checkout
   * email IS the account email. */
  async function continueToCheckout(email: string, planOverride?: string) {
    const plan = planOverride || planParam || 'single'
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, hire: 'friend', plan, trial_days: 7 }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string }
      if (data.url) {
        window.location.href = data.url
        return
      }
    } catch {
      /* fall through to the app */
    }
    navigate('/app')
  }

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
          void continueToCheckout(data.email)
          return
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Google sign in failed')
      })
      .finally(() => {
        setBusy(false)
        setParams({}, { replace: true })
      })
  }, [navigate, params, setParams])

  /* A returning, complete account with a plan in the URL goes straight to
   * Stripe — never strand a paid intent on the app home. */
  if (existing?.email && existing.phone) {
    if (planParam) {
      void continueToCheckout(existing.email)
      return null
    }
    return <Navigate to="/app" replace />
  }

  async function finish(nextName: string, nextEmail: string, nextPhone: string) {
    setBusy(true)
    setError('')
    try {
      await apiSignIn(nextEmail, nextPhone, nextName)
      signIn(nextEmail, nextPhone, nextName)
      // Same phone re-assert as the register path: the DB row must carry the
      // number even if a guest checkout raced ahead of this step.
      void apiSavePhone(nextEmail, nextPhone, nextName).catch(() => undefined)
      await hydrateFromServer().catch(() => undefined)
      if (planParam) {
        void continueToCheckout(nextEmail)
        return
      }
      // Phone just landed on the account: if they already pay, home; else the
      // default single trial checkout.
      try {
        const res = await fetch(`/api/billing/status?email=${encodeURIComponent(nextEmail)}`)
        const st = (await res.json().catch(() => ({}))) as { hires?: Record<string, boolean> }
        if (st.hires?.friend) {
          navigate('/app')
          return
        }
      } catch {
        /* fall through to checkout */
      }
      void continueToCheckout(nextEmail)
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
    if (mode === 'signup' && !nextName) {
      setError('What should they call you?')
      return
    }
    if (!nextEmail || !nextEmail.includes('@')) {
      setError('Enter a valid email.')
      return
    }
    // The password form only applies before Google or a password sign in has
    // gone through; those flows finish with a phone step instead.
    if (!googleUser && !pwSignedIn) {
      if (!password) {
        setError('Enter your password.')
        return
      }
      if (password.length < 8) {
        setError('Password needs at least 8 characters.')
        return
      }
    }
    if ((mode === 'signup' || pwSignedIn) && nextPhone.replace(/\D/g, '').length < 10) {
      setError('Enter the phone you text from in Messages, including area code.')
      return
    }
    setBusy(true)
    setError('')
    if (needsPhoneStep) {
      // Google and password sign ins that still lack a number land here to
      // finish the profile, the same apiSignIn path as before.
      void finish(nextName, nextEmail, nextPhone)
      return
    }
    if (mode === 'signup') {
      void apiRegisterPassword({ email: nextEmail, password, phone: nextPhone, name: nextName })
        .then(async (data) => {
          signIn(data.email, data.phone || nextPhone, data.name || nextName)
          // Re-assert the phone on the server no matter what raced ahead of
          // us (guest checkout, webhook) — PUT /api/me/phone backfills the
          // row and queues intros for every hire on the roster.
          void apiSavePhone(data.email, data.phone || nextPhone, data.name || nextName)
            .catch(() => undefined)
          await hydrateFromServer().catch(() => undefined)
          // A fresh account always goes to Stripe (defaults to the single-hire
          // trial when no plan was picked on the pricing card).
          void continueToCheckout(data.email)
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : 'Could not create account')
        })
        .finally(() => setBusy(false))
      return
    }
    void apiLoginPassword(nextEmail, password)
      .then(async (data) => {
        if (data.phone) {
          signIn(data.email, data.phone, data.name || nextName)
          await hydrateFromServer().catch(() => undefined)
          // A returning sign-in only starts checkout when there is no active
          // subscription yet — never re-charge someone who already pays.
          void (async () => {
            try {
              const res = await fetch(`/api/billing/status?email=${encodeURIComponent(data.email)}`)
              const st = (await res.json().catch(() => ({}))) as { hires?: Record<string, boolean> }
              if (st.hires?.friend) {
                navigate('/app')
                return
              }
              void continueToCheckout(data.email)
            } catch {
              void continueToCheckout(data.email)
            }
          })()
          return
        }
        // Signed in, but the account has no number yet: same completion step
        // the Google flow uses.
        setPwSignedIn(true)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Email or password is wrong')
      })
      .finally(() => setBusy(false))
  }

  const needsPhoneStep = googleUser || pwSignedIn

  /* ─── Main Auth Screen ────────────────────────────────────────── */
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Link to="/" aria-label="HireAlpha Home">
            <img src="/HireAlpha_logo.png" alt="HireAlpha" className="auth-brand-logo" />
          </Link>
        </div>

        {/* Mode Switcher Tabs */}
        {!needsPhoneStep && (
          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signin'}
              className={`auth-tab${mode === 'signin' ? ' is-active' : ''}`}
              onClick={() => setMode('signin')}
            >
              Sign In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              className={`auth-tab${mode === 'signup' ? ' is-active' : ''}`}
              onClick={() => setMode('signup')}
            >
              Create Account
            </button>
          </div>
        )}

        <div className="auth-header">
          <h1 className="auth-title">
            {needsPhoneStep
              ? 'Complete Account'
              : mode === 'signin'
                ? 'Welcome back'
                : 'Create your account'}
          </h1>
          <p className="auth-subtitle">
            {needsPhoneStep
              ? 'Enter the number Alpha texts in Messages.'
              : mode === 'signup'
                ? 'One number in Messages. Alpha texts first.'
                : ''}
          </p>
        </div>

        {!googleUser && !needsPhoneStep && (
          <>
            <button
              id="onb-google-btn"
              type="button"
              className="auth-btn auth-btn--google"
              onClick={onGoogle}
              disabled={busy}
            >
              <GoogleMark />
              <span>{mode === 'signin' ? 'Sign in with Google' : 'Continue with Google'}</span>
            </button>

            <div className="auth-divider">
              <span>or</span>
            </div>
          </>
        )}

        <form onSubmit={onEmailSubmit} className="auth-form">
          {mode === 'signup' && !pwSignedIn && !needsPhoneStep && (
            <div className="auth-field">
              <label className="auth-label">Name</label>
              <input
                type="text"
                required
                autoComplete="name"
                className="auth-input"
                placeholder="Full name"
                value={name}
                onChange={(e) => { setName(e.target.value); if (error) setError('') }}
              />
            </div>
          )}
          {!googleUser && !needsPhoneStep && (
            <div className="auth-field">
              <label className="auth-label">Email</label>
              <input
                type="email"
                required
                autoComplete="email"
                className="auth-input"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (error) setError('') }}
              />
            </div>
          )}
          {!needsPhoneStep && (
            <div className="auth-field">
              <div className="auth-label-row">
                <label className="auth-label">Password</label>
                <button
                  type="button"
                  className="auth-link-text"
                  onClick={() => setShowPassword((s) => !s)}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                className="auth-input"
                placeholder={mode === 'signup' ? 'At least 8 characters' : 'Password'}
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (error) setError('') }}
              />
            </div>
          )}
          {(mode === 'signup' || needsPhoneStep) && (
            <div className="auth-field">
              <label className="auth-label">Mobile Phone (for iMessage)</label>
              <input
                type="tel"
                required
                autoFocus={needsPhoneStep}
                autoComplete="tel"
                className="auth-input"
                placeholder="+1 (555) 000-0000"
                value={phone}
                onChange={(e) => { setPhone(e.target.value); if (error) setError('') }}
              />
            </div>
          )}

          {error && <p className="auth-error" role="alert">{error}</p>}

          <button id="onb-submit-btn" type="submit" className="auth-btn auth-btn--primary" disabled={busy}>
            {busy
              ? 'Please wait…'
              : needsPhoneStep
                ? 'Save and Continue'
                : mode === 'signin'
                  ? 'Sign In'
                  : 'Create Account'}
          </button>
        </form>
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
