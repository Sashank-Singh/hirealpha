import { useState, useEffect, useCallback, useMemo } from 'react'
import type { FeatureAuth } from './FeatureMiniApps'
import { apiVaultList, apiVaultSave, apiVaultSaveHandoff, apiVaultDelete, type VaultEntry } from './api'
import './vaultApp.css'

/* Every failure path in here funnels through one string so the alert never
 * renders "[object Object]" or an empty line when the server sends a body
 * without an `error` field. */
function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return fallback
}

function displayHost(urlStr: string): string {
  try {
    const u = new URL(urlStr.startsWith('http') ? urlStr : `https://${urlStr}`)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return urlStr
  }
}

/** Stable per-site hue, so amazon.com keeps the same tile colour every visit. */
function hostHue(host: string): number {
  let h = 0
  for (let i = 0; i < host.length; i += 1) h = (h * 31 + host.charCodeAt(i)) % 360
  return h
}

function initialsFor(host: string): string {
  const clean = host.replace(/^www\./, '')
  const parts = clean.split(/[.\-_]/).filter(Boolean)
  const first = parts[0] || clean
  return (first[0] || '?').toUpperCase()
}

/** "just now" / "4h ago" / "3d ago" / "Aug 28" — never a raw ISO string. */
function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

type SaveResult = { host: string; kind: 'encrypted' | 'handoff' }

function passwordScore(pw: string): number {
  if (!pw) return 0
  let score = 1
  if (pw.length >= 8) score += 1
  if (pw.length >= 12) score += 1
  if (/[0-9]/.test(pw) && /[a-zA-Z]/.test(pw)) score += 1
  if (/[^a-zA-Z0-9]/.test(pw)) score += 1
  return Math.min(4, score)
}

const SCORE_LABEL = ['', 'Weak', 'Fair', 'Good', 'Strong']

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  )
}

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.3 4" />
      <path d="M6.3 7.8A16.7 16.7 0 0 0 2.5 12s3.5 6 9.5 6a9.4 9.4 0 0 0 3.7-.75" />
      <path d="M9.9 10a3 3 0 0 0 4.2 4.2" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11.5a8 8 0 1 0-2.6 6.3" />
      <path d="M20 4.5v7h-7" />
    </svg>
  )
}

function SiteTile({ host, size = 'md' }: { host: string; size?: 'md' | 'sm' }) {
  return (
    <span
      className={`vault-app__tile vault-app__tile--${size}`}
      style={{ '--vault-tile-hue': String(hostHue(host)) } as React.CSSProperties}
      aria-hidden="true"
    >
      {initialsFor(host)}
    </span>
  )
}

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
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState<'save' | 'handoff' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SaveResult | null>(null)
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[] | null>(null)
  const [entriesLoading, setEntriesLoading] = useState(!captureOnly)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const loadEntries = useCallback(async () => {
    try {
      const res = await apiVaultList({ token: auth.token, email: auth.email })
      if (res && Array.isArray(res.entries)) {
        setVaultEntries(res.entries)
      }
    } catch {
      // Non-fatal: vault list might be empty or loading
    } finally {
      setEntriesLoading(false)
    }
  }, [auth.token, auth.email])

  useEffect(() => {
    if (!captureOnly) void loadEntries()
  }, [captureOnly, loadEntries])

  const targetHost = portal.trim() ? displayHost(portal.trim()) : ''
  const isCapture = captureOnly
  const score = passwordScore(password)
  const alreadySaved = useMemo(
    () => Boolean(vaultEntries?.some((item) => displayHost(item.portal) === targetHost)),
    [vaultEntries, targetHost],
  )

  const missing: string[] = []
  if (!portal.trim()) missing.push('website')
  if (!username.trim() && !isCapture) missing.push('username')
  if (password.length < 3) missing.push('password')

  async function handleSaveEncrypted(e?: React.FormEvent) {
    if (e) e.preventDefault()
    const targetPortal = portal.trim()
    if (!targetPortal || password.length < 3) {
      setError('Please provide a website URL and password.')
      return
    }

    setBusy('save')
    setError(null)
    setResult(null)

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
        setResult({ host: displayHost(targetPortal), kind: 'encrypted' })
        setPassword('')
        setShowPassword(false)
        if (!captureOnly) void loadEntries()
      } else {
        setError('Failed to save credentials. Please try again.')
      }
    } catch (err) {
      setError(errMessage(err, 'Could not save credentials to vault.'))
    } finally {
      setBusy(null)
    }
  }

  async function handleSaveHandoff() {
    const targetPortal = portal.trim()
    if (!targetPortal) {
      setError('Please provide a website URL for private sign-in.')
      return
    }

    setBusy('handoff')
    setError(null)
    setResult(null)

    try {
      const res = await apiVaultSaveHandoff({
        token: auth.token,
        email: auth.email,
        persona: auth.persona,
        portal: targetPortal,
      })

      if (res && res.ok !== false) {
        setResult({ host: displayHost(targetPortal), kind: 'handoff' })
        void loadEntries()
      } else {
        setError('Failed to configure private sign-in.')
      }
    } catch (err) {
      setError(errMessage(err, 'Could not save handoff settings.'))
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(id: string) {
    setRevokingId(id)
    try {
      await apiVaultDelete({ token: auth.token, email: auth.email, id })
      setVaultEntries((prev) => (prev ? prev.filter((item) => item.id !== id) : null))
    } catch (err) {
      setError(errMessage(err, 'Could not delete vault entry.'))
    } finally {
      setRevokingId(null)
    }
  }

  function startAnother() {
    setResult(null)
    setError(null)
    setPassword('')
    setShowPassword(false)
  }

  const busyNow = busy !== null
  const methodLabel = (item: VaultEntry) => (item.backed === 'handoff' ? 'Private handoff' : 'Encrypted')

  return (
    <div className={`vault-app${captureOnly ? ' vault-app--capture' : ''}`}>
      <div className="vault-app__card">
        <section className="vault-app__hero">
          <div className="vault-app__hero-glow" aria-hidden="true" />

          <div className="vault-app__hero-top">
            <span className="vault-app__badge">
              <LockIcon className="vault-app__badge-icon" />
              <span>HireAlpha Vault</span>
            </span>
            {!isCapture && targetHost && alreadySaved && (
              <span className="vault-app__status-pill">
                <span className="vault-app__dot" />
                Saved
              </span>
            )}
          </div>

          <div className="vault-app__identity">
            <SiteTile host={targetHost || 'hirealpha'} size="md" />
            <div className="vault-app__identity-text">
              <h1 className="vault-app__title">
                {targetHost ? (
                  <>
                    Sign in to <span className="vault-app__title-host">{targetHost}</span>
                  </>
                ) : (
                  'Add a login to the vault'
                )}
              </h1>
              <p className="vault-app__desc">
                Encrypted for your account and unlocked only for this site — never sent through Messages, never shown to Alpha.
              </p>
            </div>
          </div>

          <ul className="vault-app__chips">
            <li className="vault-app__chip">
              <LockIcon className="vault-app__chip-icon" />
              Encrypted at rest
            </li>
            <li className="vault-app__chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="vault-app__chip-icon">
                <circle cx="12" cy="12" r="8.5" />
                <path d="M12 3.5v17M3.5 12h17" />
              </svg>
              {targetHost ? `Scoped to ${targetHost}` : 'Scoped to one site'}
            </li>
            <li className="vault-app__chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="vault-app__chip-icon">
                <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" />
                <path d="M4 20L20 4" />
              </svg>
              Alpha never sees it
            </li>
          </ul>
        </section>

        {error && (
          <div className="vault-app__alert vault-app__alert--error" role="alert">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5M12 16.5h.01" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {result ? (
          <section className="vault-app__result" role="status">
            <div className="vault-app__check" aria-hidden="true">
              <CheckIcon />
            </div>
            <h2 className="vault-app__result-title">
              {result.kind === 'encrypted' ? 'Login saved' : 'Private sign-in ready'}
            </h2>
            <p className="vault-app__result-body">
              {result.kind === 'encrypted' ? (
                <>Credentials for <strong>{result.host}</strong> are encrypted in your vault. Your task is now active.</>
              ) : (
                <>When the browser reaches the <strong>{result.host}</strong> login page, it will pause and hand the screen to you.</>
              )}
            </p>
            <div className="vault-app__result-tags">
              <span className="vault-app__tag">
                <span className="vault-app__dot" />
                Task active
              </span>
              <span className="vault-app__tag">{result.kind === 'encrypted' ? 'Encrypted Vault' : 'Private handoff'}</span>
              <span className="vault-app__tag">{result.host}</span>
            </div>
            <div className="vault-app__actions vault-app__actions--result">
              <a href="sms:+14155951440" className="vault-app__btn vault-app__btn--primary">
                Return to Messages
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />
                </svg>
              </a>
              <button type="button" className="vault-app__btn vault-app__btn--ghost" onClick={startAnother}>
                Save another login
              </button>
            </div>
          </section>
        ) : (
          <form className="vault-app__form" onSubmit={handleSaveEncrypted}>
            <div className="vault-app__group">
              <label className="vault-app__label" htmlFor="vault-portal">
                Website or service
              </label>
              <div className="vault-app__field">
                <svg className="vault-app__field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="8.5" />
                  <path d="M12 3.5v17M3.5 12h17" />
                </svg>
                <input
                  id="vault-portal"
                  className="vault-app__input vault-app__input--with-icon"
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="e.g. campusnet.csuohio.edu"
                  value={portal}
                  onChange={(e) => setPortal(e.target.value)}
                  disabled={busyNow}
                />
              </div>
            </div>

            <div className="vault-app__group">
              <label className="vault-app__label" htmlFor="vault-username">
                Email or username
              </label>
              <div className="vault-app__field">
                <svg className="vault-app__field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="8.5" r="3.5" />
                  <path d="M5 19.5a7 7 0 0 1 14 0" />
                </svg>
                <input
                  id="vault-username"
                  className="vault-app__input vault-app__input--with-icon"
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  placeholder="you@example.com"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={busyNow}
                />
              </div>
            </div>

            <div className="vault-app__group">
              <label className="vault-app__label" htmlFor="vault-password">
                Password
              </label>
              <div className="vault-app__field">
                <svg className="vault-app__field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4" y="10.5" width="16" height="9.5" rx="2.5" />
                  <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
                </svg>
                <input
                  id="vault-password"
                  className="vault-app__input vault-app__input--with-icon vault-app__input--with-action"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busyNow}
                  autoFocus={isCapture}
                />
                <button
                  type="button"
                  className="vault-app__reveal"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  disabled={busyNow}
                >
                  <EyeIcon open={showPassword} />
                </button>
              </div>
              {password.length > 0 && (
                <div className="vault-app__strength" data-score={score}>
                  <span className="vault-app__strength-bars" aria-hidden="true">
                    {[1, 2, 3, 4].map((i) => (
                      <span key={i} className={`vault-app__bar${i <= score ? ' is-on' : ''}`} />
                    ))}
                  </span>
                  <span className="vault-app__strength-label">{SCORE_LABEL[score]}</span>
                </div>
              )}
            </div>

            <div className="vault-app__actions">
              <button
                type="submit"
                className="vault-app__btn vault-app__btn--primary"
                disabled={busyNow || !portal.trim() || (!username.trim() && !isCapture) || password.length < 3}
              >
                {busy === 'save' ? (
                  <>
                    <span className="vault-app__spinner" aria-hidden="true" />
                    Saving securely…
                  </>
                ) : (
                  <>
                    <LockIcon className="vault-app__btn-icon" />
                    Save encrypted login
                  </>
                )}
              </button>
              {!isCapture && (
                <button
                  type="button"
                  className="vault-app__btn vault-app__btn--ghost"
                  onClick={handleSaveHandoff}
                  disabled={busyNow || !portal.trim()}
                >
                  {busy === 'handoff' ? (
                    <>
                      <span className="vault-app__spinner" aria-hidden="true" />
                      Setting up…
                    </>
                  ) : (
                    'Use no-save sign-in instead'
                  )}
                </button>
              )}
              {missing.length > 0 && (
                <p className="vault-app__missing" aria-live="polite">
                  Add {missing.join(', ')} to continue
                </p>
              )}
              {!isCapture && (
                <p className="vault-app__form-note">
                  No-save sign-in never stores the password: the browser pauses at {targetHost || 'the'} login and hands the screen to you.
                </p>
              )}
            </div>
          </form>
        )}

        {isCapture && !result && (
          <a href="sms:+14155951440" className="vault-app__return-link">Return to Messages</a>
        )}

        {!isCapture && !result && (
          <section className="vault-app__saved-section">
            <div className="vault-app__section-head">
              <h2 className="vault-app__section-title">
                Saved logins
                {vaultEntries && vaultEntries.length > 0 && (
                  <span className="vault-app__count">{vaultEntries.length}</span>
                )}
              </h2>
              <button
                type="button"
                className="vault-app__refresh"
                onClick={() => { setEntriesLoading(true); void loadEntries() }}
                aria-label="Refresh saved logins"
                disabled={entriesLoading}
              >
                <RefreshIcon />
              </button>
            </div>

            {entriesLoading && !vaultEntries && (
              <ul className="vault-app__entries" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <li key={i} className="vault-app__entry vault-app__entry--skeleton">
                    <span className="vault-app__tile vault-app__tile--sm vault-app__skel vault-app__skel--tile" />
                    <span className="vault-app__entry-info">
                      <span className="vault-app__skel vault-app__skel--line" />
                      <span className="vault-app__skel vault-app__skel--line vault-app__skel--short" />
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {vaultEntries && vaultEntries.length === 0 && (
              <div className="vault-app__empty">
                <LockIcon className="vault-app__empty-icon" />
                <p className="vault-app__empty-title">Nothing in the vault yet</p>
                <p className="vault-app__empty-body">Save a login above and Alpha can sign in for you without ever holding the password in the chat.</p>
              </div>
            )}

            {vaultEntries && vaultEntries.length > 0 && (
              <ul className="vault-app__entries">
                {vaultEntries.map((item, index) => {
                  const host = displayHost(item.portal)
                  const used = relativeTime(item.last_used_at)
                  const added = relativeTime(item.created_at)
                  return (
                    <li
                      key={item.id}
                      className={`vault-app__entry${revokingId === item.id ? ' is-revoking' : ''}`}
                      style={{ '--vault-row-index': String(index) } as React.CSSProperties}
                    >
                      <SiteTile host={host} size="sm" />
                      <span className="vault-app__entry-info">
                        <span className="vault-app__entry-host">{host}</span>
                        <span className="vault-app__entry-sub">
                          <span className="vault-app__entry-user">{item.username_masked || 'Account'}</span>
                          <span className="vault-app__entry-dot" aria-hidden="true">•</span>
                          <span className={`vault-app__entry-method${item.backed === 'handoff' ? ' is-handoff' : ''}`}>
                            {methodLabel(item)}
                          </span>
                        </span>
                        <span className="vault-app__entry-meta">
                          {used ? `Last used ${used}` : `Added ${added || 'recently'}`}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="vault-app__entry-del"
                        onClick={() => void handleDelete(item.id)}
                        disabled={revokingId === item.id}
                        aria-label={`Revoke access for ${item.portal}`}
                        title="Revoke"
                      >
                        {revokingId === item.id ? (
                          <span className="vault-app__spinner vault-app__spinner--sm" aria-hidden="true" />
                        ) : (
                          <TrashIcon />
                        )}
                        <span className="vault-app__entry-del-label">Revoke</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
