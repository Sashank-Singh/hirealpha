import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { apiLoginPassword, apiRegisterPassword, apiSavePhone, apiSignIn } from './api'
import { getSession, hydrateFromServer, signIn } from './roster'

type AuthMode = 'signin' | 'signup'

export function LoginPage() {
  const existing = getSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const emailParam = params.get('email') || ''
  const planParam = params.get('plan') || ''
  const [mode, setMode] = useState<AuthMode>(existing?.name ? 'signin' : 'signup')
  const [name, setName] = useState(existing?.name || '')
  const [email, setEmail] = useState(existing?.email || emailParam)
  const [phone, setPhone] = useState(existing?.phone || '')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
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

  function onEmailSubmit(e: FormEvent) {
    e.preventDefault()
    const nextName = name.trim()
    const nextEmail = email.trim().toLowerCase()
    const nextPhone = phone.trim()

    // Password verified, account lacks a number: finish the profile now.
    if (pwSignedIn) {
      if (nextPhone.replace(/\D/g, '').length < 10) {
        setError('Enter the phone you text from in Messages, including area code.')
        return
      }
      setBusy(true)
      setError('')
      void finish(nextName, nextEmail, nextPhone)
      return
    }

    if (mode === 'signup' && !nextName) {
      setError('What should they call you?')
      return
    }
    if (!nextEmail || !nextEmail.includes('@')) {
      setError('Enter a valid email.')
      return
    }
    if (!password) {
      setError('Enter your password.')
      return
    }
    if (password.length < 8) {
      setError('Password needs at least 8 characters.')
      return
    }
    if (mode === 'signup' && nextPhone.replace(/\D/g, '').length < 10) {
      setError('Enter the phone you text from in Messages, including area code.')
      return
    }
    setBusy(true)
    setError('')
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
          // Same re-assert as register: the phone must reach the DB no matter
          // which path created the account (guest checkout, webhook).
          void apiSavePhone(data.email, data.phone, data.name || nextName).catch(() => undefined)
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
        // Signed in, but the account has no number yet. Reuse the finish flow
        // (password is already verified server-side) by clearing the password
        // field and letting the submit run the apiSignIn path.
        setPwSignedIn(true)
        setPassword('')
        setPhone(existing?.phone || '')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Email or password is wrong')
      })
      .finally(() => setBusy(false))
  }

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
        {!pwSignedIn && (
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
            {pwSignedIn
              ? 'Complete Account'
              : mode === 'signin'
                ? 'Welcome back'
                : 'Create your account'}
          </h1>
          <p className="auth-subtitle">
            {pwSignedIn
              ? 'Enter the number Alpha texts in Messages.'
              : mode === 'signup'
                ? 'One number in Messages. Alpha texts first.'
                : ''}
          </p>
        </div>

        <form onSubmit={onEmailSubmit} className="auth-form">
          {mode === 'signup' && !pwSignedIn && (
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
          {!pwSignedIn && (
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
          {!pwSignedIn && (
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
          {(mode === 'signup' || pwSignedIn) && (
            <div className="auth-field">
              <label className="auth-label">Mobile Phone (for iMessage)</label>
              <input
                type="tel"
                required
                autoFocus={pwSignedIn}
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
              : pwSignedIn
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

