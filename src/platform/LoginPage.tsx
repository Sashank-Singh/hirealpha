import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { apiSignIn } from './api'
import { getSession, hydrateFromServer, signIn } from './roster'

export function LoginPage() {
  const existing = getSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (existing?.email && existing.phone) return <Navigate to="/app" replace />

  async function finish(nextEmail: string, nextPhone: string) {
    setBusy(true)
    setError('')
    try {
      await apiSignIn(nextEmail, nextPhone)
      signIn(nextEmail, nextPhone)
      await hydrateFromServer().catch(() => undefined)
      navigate('/app')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const nextEmail = email.trim().toLowerCase()
    const nextPhone = phone.trim()
    if (!nextEmail || !nextEmail.includes('@')) {
      setError('Enter a valid email.')
      return
    }
    if (nextPhone.replace(/\D/g, '').length < 10) {
      setError('Enter the phone you text from in Messages, including area code.')
      return
    }
    void finish(nextEmail, nextPhone)
  }

  return (
    <div className="plat plat--auth">
      <div className="plat-auth">
        <p className="plat-auth__brand">HireAlpha</p>
        <h1>Sign in</h1>
        <p className="plat-auth__sub">
          Use the same phone you text the hires from. That is how they find your config and connected apps.
        </p>

        <form onSubmit={onSubmit} className="plat-auth__form">
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
          <label>
            iMessage phone
            <input
              type="tel"
              required
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
            {busy ? 'Signing in…' : 'Continue'}
          </button>
        </form>

        <p className="plat-auth__foot">
          <Link to="/" className="plat-link">
            Back to site
          </Link>
        </p>
      </div>
    </div>
  )
}
