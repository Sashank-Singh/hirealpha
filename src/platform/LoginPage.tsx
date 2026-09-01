import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { apiExchangeGoogle, apiLoginPassword, apiRegisterPassword, apiSignIn } from './api'
import { getSession, hydrateFromServer, signIn } from './roster'

type AuthMode = 'signin' | 'signup'
type Step = 'auth' | 'trial'

export function LoginPage() {
  const existing = getSession()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const emailParam = params.get('email') || ''
  const [mode, setMode] = useState<AuthMode>(existing?.name ? 'signin' : 'signup')
  const [step, setStep] = useState<Step>('auth')
  const [name, setName] = useState(existing?.name || '')
  const [email, setEmail] = useState(existing?.email || emailParam)
  const [phone, setPhone] = useState(existing?.phone || '')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [emailMode, setEmailMode] = useState(!!existing?.email || !!emailParam || !existing?.phone)
  const [googleUser, setGoogleUser] = useState(false)
  const [pwSignedIn, setPwSignedIn] = useState(false)
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
          await hydrateFromServer().catch(() => undefined)
          // Show the trial pricing screen after first sign-up
          setStep('trial')
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
          navigate('/app')
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

  async function startTrial() {
    const use = email.trim().toLowerCase()
    if (!use.includes('@')) { navigate('/app'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: use, hire: 'friend', plan: 'single', trial_days: 7 }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string }
      if (data.url) { window.location.href = data.url; return }
    } catch { /* fall through */ } finally { setBusy(false) }
    navigate('/app')
  }

  /* ─── Trial / pricing screen ─────────────────────────────────── */
  if (step === 'trial') {
    return (
      <div className="onb-root">
        <div className="onb-card">
          <div className="onb-logo">A</div>
          <h1 className="onb-h1">Try Alpha free</h1>
          <p className="onb-sub">7 days free, then $5/month for 2 months, then $19/month. Cancel anytime.</p>
          <ul className="onb-features">
            <li>
              <span className="onb-feat-icon">💬</span>
              <div>
                <strong>Unlimited iMessage texts</strong>
                <p>Alpha lives in your Messages app. Just text.</p>
              </div>
            </li>
            <li>
              <span className="onb-feat-icon">🔗</span>
              <div>
                <strong>Connect your tools</strong>
                <p>Gmail, Calendar, Notion, Linear, GitHub, and more.</p>
              </div>
            </li>
            <li>
              <span className="onb-feat-icon">🤖</span>
              <div>
                <strong>Background tasks &amp; loops</strong>
                <p>Alpha works autonomously, even when you&apos;re not watching.</p>
              </div>
            </li>
          </ul>
          <button id="onb-trial-cta" type="button" className="onb-btn" onClick={() => void startTrial()} disabled={busy}>
            {busy ? 'Opening…' : 'Start free trial →'}
          </button>
          <button type="button" className="onb-skip" onClick={() => navigate('/app')}>
            Skip for now
          </button>
        </div>
      </div>
    )
  }

  /* ─── Auth screen ─────────────────────────────────────────────── */
  return (
    <div className="onb-root">
      <div className="onb-card">
        <div className="onb-logo">A</div>
        <h1 className="onb-h1">
          {needsPhoneStep
            ? 'One more step'
            : mode === 'signup'
              ? 'Get started with Alpha'
              : 'Welcome back'}
        </h1>
        <p className="onb-sub">
          {needsPhoneStep
            ? 'Add the phone you text from so Alpha can find you in Messages.'
            : mode === 'signup'
              ? 'Your personal AI, right in iMessage.'
              : 'Sign in to your account.'}
        </p>

        {!googleUser && !needsPhoneStep && (
          <button
            id="onb-google-btn"
            type="button"
            className="onb-btn onb-btn--google"
            onClick={onGoogle}
            disabled={busy}
          >
            <GoogleMark />
            {mode === 'signup' ? 'Continue with Google' : 'Sign in with Google'}
          </button>
        )}

        {!emailMode && !googleUser ? (
          <button type="button" className="onb-skip" onClick={() => setEmailMode(true)}>
            Use email instead
          </button>
        ) : (
          <form onSubmit={onEmailSubmit} className="onb-form">
            {mode === 'signup' && !pwSignedIn && !needsPhoneStep && (
              <input
                type="text"
                required
                autoComplete="name"
                className="onb-input"
                placeholder="First name"
                value={name}
                onChange={(e) => { setName(e.target.value); if (error) setError('') }}
              />
            )}
            {!googleUser && !needsPhoneStep && (
              <input
                type="email"
                required
                autoComplete="email"
                className="onb-input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (error) setError('') }}
              />
            )}
            {!needsPhoneStep && (
              <div className="onb-pw-wrap">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  className="onb-input"
                  placeholder={mode === 'signup' ? 'Password (8+ chars)' : 'Password'}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (error) setError('') }}
                />
                <button
                  type="button"
                  className="onb-pw-toggle"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            )}
            {(mode === 'signup' || needsPhoneStep) && (
              <input
                type="tel"
                required
                autoFocus={needsPhoneStep}
                autoComplete="tel"
                className="onb-input"
                placeholder="+1 (555) 010-9876"
                value={phone}
                onChange={(e) => { setPhone(e.target.value); if (error) setError('') }}
              />
            )}
            {error && <p className="onb-error" role="alert">{error}</p>}
            <button id="onb-submit-btn" type="submit" className="onb-btn" disabled={busy}>
              {busy
                ? 'One moment…'
                : needsPhoneStep
                  ? 'Continue →'
                  : mode === 'signup'
                    ? 'Create account →'
                    : 'Sign in →'}
            </button>
          </form>
        )}

        {!googleUser && !pwSignedIn && (
          <button
            type="button"
            className="onb-skip"
            onClick={() => setMode((m) => (m === 'signup' ? 'signin' : 'signup'))}
          >
            {mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create account'}
          </button>
        )}

        <p className="onb-foot">
          <Link to="/" className="onb-foot-link">← Back to site</Link>
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
