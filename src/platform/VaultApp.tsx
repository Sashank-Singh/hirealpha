import { useState, useEffect, useCallback } from 'react'
import type { FeatureAuth } from './FeatureMiniApps'
import { apiVaultList, apiVaultSave, apiVaultSaveHandoff, apiVaultDelete, type VaultEntry } from './api'
import './vaultApp.css'

export function VaultApp({
  auth,
  portal: initialPortal,
  initialUsername,
  captureOnly = false,
}: {
  auth: FeatureAuth
  portal?: string
  initialUsername?: string
  captureOnly?: boolean
}) {
  const searchParams = new URLSearchParams(window.location.search)
  const defaultPortal = initialPortal || searchParams.get('portal') || searchParams.get('url') || searchParams.get('site') || ''

  const [portal, setPortal] = useState(defaultPortal)
  const [username, setUsername] = useState(initialUsername || '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[] | null>(null)

  const loadEntries = useCallback(async () => {
    try {
      const res = await apiVaultList({ token: auth.token, email: auth.email })
      if (res && Array.isArray(res.entries)) {
        setVaultEntries(res.entries)
      }
    } catch {
      // Non-fatal: vault list might be empty or loading
    }
  }, [auth.token, auth.email])

  useEffect(() => {
    if (!captureOnly) void loadEntries()
  }, [captureOnly, loadEntries])

  async function handleSaveEncrypted(e?: React.FormEvent) {
    if (e) e.preventDefault()
    const targetPortal = portal.trim()
    if (!targetPortal || password.length < 3) {
      setError('Please provide a website URL and password.')
      return
    }

    setBusy(true)
    setError(null)
    setSuccess(null)

    try {
      const res = await apiVaultSave({
        token: auth.token,
        email: auth.email,
        persona: auth.persona,
        portal: targetPortal,
        username: username.trim(),
        secret: password,
      })

      if (res && res.ok !== false) {
        setSuccess(`Credentials saved securely for ${displayHost(targetPortal)}! Your task is now active.`)
        setPassword('')
        if (!captureOnly) void loadEntries()
      } else {
        setError('Failed to save credentials. Please try again.')
      }
    } catch (err: any) {
      setError(err?.message || 'Could not save credentials to vault.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveHandoff() {
    const targetPortal = portal.trim()
    if (!targetPortal) {
      setError('Please provide a website URL for private sign-in.')
      return
    }

    setBusy(true)
    setError(null)
    setSuccess(null)

    try {
      const res = await apiVaultSaveHandoff({
        token: auth.token,
        email: auth.email,
        persona: auth.persona,
        portal: targetPortal,
      })

      if (res && res.ok !== false) {
        setSuccess(`Private sign-in configured for ${displayHost(targetPortal)}! When the browser reaches the login page, it will pause for you.`)
        void loadEntries()
      } else {
        setError('Failed to configure private sign-in.')
      }
    } catch (err: any) {
      setError(err?.message || 'Could not save handoff settings.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiVaultDelete({ token: auth.token, email: auth.email, id })
      setVaultEntries((prev) => (prev ? prev.filter((item) => item.id !== id) : null))
    } catch (err: any) {
      setError(err?.message || 'Could not delete vault entry.')
    }
  }

  function displayHost(urlStr: string): string {
    try {
      const u = new URL(urlStr.startsWith('http') ? urlStr : `https://${urlStr}`)
      return u.hostname.replace(/^www\./, '')
    } catch {
      return urlStr
    }
  }

  return (
    <div className={`vault-app${captureOnly ? ' vault-app--capture' : ''}`}>
      <div className="vault-app__card">
        {!captureOnly && <div className="vault-app__topbar">
          <a
            href="sms:+14155951440"
            className="vault-app__back-link"
            onClick={(e) => {
              if (window.history.length > 1) {
                e.preventDefault()
                window.history.back()
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <span>Back to Messages</span>
          </a>
          <span className="vault-app__dismiss-hint">Swipe down or tap to return</span>
        </div>}

        <header className="vault-app__head">
          <div className="vault-app__badge">
            <span className="vault-app__lock-icon" aria-hidden="true">🔒</span>
            <span>HIREALPHA VAULT</span>
          </div>
          <h1 className="vault-app__title">
            {portal ? `Sign in to ${displayHost(portal)}` : 'Add a login to HireAlpha Vault'}
          </h1>
          <p className="vault-app__desc">
            Your password is encrypted for your account and restricted to this website. It is never sent through Messages or shown to Alpha.
          </p>
        </header>

        {error && (
          <div className="vault-app__alert vault-app__alert--error" role="alert">
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="vault-app__alert vault-app__alert--success" role="status">
            <p>{success}</p>
            <a href="sms:+14155951440" className="vault-app__sms-btn">
              Return to Messages
            </a>
          </div>
        )}

        {!success && <form className="vault-app__form" onSubmit={handleSaveEncrypted}>
          <div className="vault-app__group">
            <label className="vault-app__label" htmlFor="vault-portal">
              Website or Service
            </label>
            <input
              id="vault-portal"
              className="vault-app__input"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="e.g. campusnet.csuohio.edu, amazon.com"
              value={portal}
              onChange={(e) => setPortal(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="vault-app__group">
            <label className="vault-app__label" htmlFor="vault-username">
              Email or username
            </label>
            <input
              id="vault-username"
              className="vault-app__input"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              placeholder="you@example.com"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="vault-app__group">
            <label className="vault-app__label" htmlFor="vault-password">
              Password
            </label>
            <input
              id="vault-password"
              className="vault-app__input"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              autoFocus={captureOnly}
            />
          </div>

          <div className="vault-app__actions">
            <button
              type="submit"
              className="vault-app__btn vault-app__btn--primary"
              disabled={busy || !portal.trim() || !username.trim() || password.length < 3}
            >
              {busy ? 'Saving securely…' : 'Save encrypted login'}
            </button>
            {!captureOnly && <button
              type="button"
              className="vault-app__btn vault-app__btn--secondary"
              onClick={handleSaveHandoff}
              disabled={busy || !portal.trim()}
            >
              Use no-save sign-in (private handoff)
            </button>}
          </div>
        </form>}

        {captureOnly && !success && (
          <a href="sms:+14155951440" className="vault-app__return-link">Return to Messages</a>
        )}

        {!captureOnly && vaultEntries && vaultEntries.length > 0 && (
          <div className="vault-app__saved-section">
            <h2 className="vault-app__section-title">Saved logins</h2>
            <div className="vault-app__entries">
              {vaultEntries.map((item) => (
                <div key={item.id} className="vault-app__entry">
                  <div className="vault-app__entry-info">
                    <span className="vault-app__entry-host">{displayHost(item.portal)}</span>
                    <span className="vault-app__entry-sub">
                      {item.username_masked || 'Account'} • {item.backed === 'handoff' ? 'Private handoff' : 'Encrypted Vault'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="vault-app__entry-del"
                    onClick={() => void handleDelete(item.id)}
                    aria-label={`Revoke access for ${item.portal}`}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
