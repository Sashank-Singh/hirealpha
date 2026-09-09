import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import './computerSession.css'

type SessionStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed'
type HandoffKind = 'password' | 'verification' | 'payment' | 'captcha' | 'confirmation' | null

interface SessionStep {
  action: string
  selector?: string
  value?: string
  ms?: number
}

interface SessionData {
  id: string
  status: SessionStatus
  kind: string
  url: string
  currentUrl?: string | null
  goal: string | null
  attempts: number
  result: string | null
  error: string | null
  streamUrl: string | null
  steps: SessionStep[]
  handoffKind?: HandoffKind
  handoffMessage?: string | null
  handoffAt?: string | null
  paymentUrl?: string | null
}

const ICONS = {
  wordmark: (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 23.5 14.3 7h3.5L25 23.5h-4.1l-1.6-4H12.6l-1.6 4H7Zm7-7.4h4l-2-5.2-2 5.2Z" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
  ),
  cursor: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 3 13.2 9.2-6.1 1.3-2.8 5.6L5 3Z"/></svg>
  ),
  external: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
  ),
}

function hostname(value?: string | null): string {
  if (!value) return 'Secure browser'
  try { return new URL(value).hostname.replace(/^www\./, '') } catch { return value }
}

function safeStepLabel(step: SessionStep): string {
  if (step.action.startsWith('needs_') || step.action.startsWith('handoff_')) return 'Paused for your input'
  switch (step.action) {
    case 'goto': return 'Opened the website'
    case 'fill':
    case 'type_text': return step.value?.includes('{{') ? 'Filled a protected field' : 'Filled a form field'
    case 'click':
    case 'click_at': return 'Selected an option'
    case 'press': return `Pressed ${step.value || 'a key'}`
    case 'wait': return 'Waited for the page'
    case 'extract': return 'Read the page'
    default: return 'Worked on the task'
  }
}

function statusCopy(status: SessionStatus): { label: string; detail: string } {
  if (status === 'pending') return { label: 'Ready to start', detail: 'Alpha is waiting for your permission to open this site.' }
  if (status === 'running') return { label: 'Alpha is working', detail: 'You can watch. Take control only when you need to step in.' }
  if (status === 'waiting') return { label: 'Needs you', detail: 'The task is paused. Your browser session stays open.' }
  if (status === 'done') return { label: 'Task complete', detail: 'Alpha finished and closed the task safely.' }
  return { label: 'Task stopped', detail: 'No further actions will be taken.' }
}

export function ComputerSessionView() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || searchParams.get('t') || ''
  const [session, setSession] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(Boolean(sessionId))
  const [error, setError] = useState('')
  const [takingControl, setTakingControl] = useState(false)
  const [acting, setActing] = useState(false)
  const [copied, setCopied] = useState(false)
  const lastStatus = useRef<SessionStatus | null>(null)
  const computerRef = useRef<HTMLElement>(null)

  const query = useMemo(() => token ? `?token=${encodeURIComponent(token)}` : '', [token])

  const loadSession = useCallback(async (quiet = false) => {
    if (!sessionId) return
    if (!quiet) setLoading(true)
    try {
      const response = await fetch(`/api/computer/session/${encodeURIComponent(sessionId)}${query}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({})) as { session?: SessionData; error?: string }
      if (!response.ok || !data.session) throw new Error(data.error || 'This computer session is unavailable.')
      setSession(data.session)
      setError('')
      if (lastStatus.current === 'waiting' && data.session.status === 'running') setTakingControl(false)
      lastStatus.current = data.session.status
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : 'This computer session is unavailable.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [query, sessionId])

  useEffect(() => {
    void loadSession()
    if (!sessionId) return
    const timer = window.setInterval(() => void loadSession(true), 2_000)
    return () => window.clearInterval(timer)
  }, [loadSession, sessionId])

  const postAction = async (action: 'approve' | 'resume' | 'cancel') => {
    if (!sessionId || acting) return
    setActing(true)
    setError('')
    try {
      const response = await fetch(`/api/computer/session/${encodeURIComponent(sessionId)}/${action}${query}`, { method: 'POST' })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(data.error || 'That action could not be completed.')
      if (action === 'resume') setTakingControl(false)
      await loadSession(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action could not be completed.')
    } finally {
      setActing(false)
    }
  }

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const takeControl = () => {
    setTakingControl(true)
    window.requestAnimationFrame(() => computerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  if (!sessionId) {
    return (
      <main className="cs-shell cs-empty-shell">
        <section className="cs-empty" aria-labelledby="empty-title">
          <div className="cs-mark">{ICONS.wordmark}</div>
          <p className="cs-eyebrow">Cloud Computer</p>
          <h1 id="empty-title">No live task</h1>
          <p>Ask Alpha in iMessage to fill a form, research a site, or prepare an order. Alpha will text you a private link when the browser starts.</p>
          <Link className="cs-button cs-button-primary" to="/">Back to HireAlpha</Link>
        </section>
      </main>
    )
  }

  if (loading) {
    return (
      <main className="cs-shell cs-empty-shell" aria-busy="true">
        <section className="cs-loading-card">
          <div className="cs-loading-line cs-loading-line-short" />
          <div className="cs-loading-screen" />
          <div className="cs-loading-line" />
        </section>
      </main>
    )
  }

  if (!session) {
    return (
      <main className="cs-shell cs-empty-shell">
        <section className="cs-empty cs-empty-error">
          <div className="cs-mark">{ICONS.lock}</div>
          <p className="cs-eyebrow">Private session</p>
          <h1>Link unavailable</h1>
          <p>{error || 'This link may have expired, or the task belongs to another HireAlpha account.'}</p>
          <Link className="cs-button cs-button-secondary" to="/">Back to HireAlpha</Link>
        </section>
      </main>
    )
  }

  const copy = statusCopy(session.status)
  const currentHost = hostname(session.currentUrl || session.url)
  const recentSteps = (session.steps || []).slice(-5).reverse()
  const canControl = session.status === 'running' || (session.status === 'waiting' && session.handoffKind !== 'payment')
  const checkpointTitle = session.handoffKind === 'payment'
    ? 'Approve the verified total'
    : session.handoffKind === 'verification'
      ? 'Enter the code from your phone'
      : session.handoffKind === 'captcha'
        ? 'Complete the security check'
        : 'Take over for a moment'

  return (
    <div className="cs-shell">
      <header className="cs-topbar">
        <Link className="cs-brand" to="/" aria-label="HireAlpha home">
          <span className="cs-mark">{ICONS.wordmark}</span>
          <span>HireAlpha</span>
        </Link>
        <div className={`cs-live-state cs-live-state-${session.status}`}>
          <span className="cs-live-dot" />
          {copy.label}
        </div>
        <div className="cs-top-actions">
          <button className="cs-icon-button" onClick={() => void copyLink()} aria-label="Copy private session link" title="Copy private link">
            {copied ? <span className="cs-copied">Copied</span> : ICONS.external}
          </button>
          <button className="cs-icon-button" aria-label="More options" title="Session options">{ICONS.more}</button>
        </div>
      </header>

      <main className="cs-workspace">
        <section ref={computerRef} className="cs-computer" aria-label="Live cloud computer">
          <div className="cs-browser-bar">
            <span className="cs-browser-security">{ICONS.lock}</span>
            <span className="cs-browser-host">{currentHost}</span>
            <span className="cs-browser-private">Private session</span>
          </div>

          <div className={`cs-stream ${takingControl ? 'cs-stream-control' : ''}`}>
            {session.streamUrl ? (
              <iframe
                className="cs-stream-frame"
                src={session.streamUrl}
                title={`Live browser on ${currentHost}`}
                allow="clipboard-read; clipboard-write"
                referrerPolicy="no-referrer"
                tabIndex={takingControl ? 0 : -1}
              />
            ) : (
              <div className="cs-stream-unavailable">
                {(session.status === 'running' || session.status === 'waiting') && <span className="cs-stream-loader" />}
                <strong>{session.status === 'done' || session.status === 'failed' ? 'Browser session closed' : 'Starting the secure browser'}</strong>
                <span>{session.status === 'done' || session.status === 'failed' ? 'The private live view ended with this task.' : 'The live screen will appear here.'}</span>
              </div>
            )}
            {!takingControl && session.streamUrl && <div className="cs-watch-shield" aria-hidden="true" />}
            {canControl && (
              <div className="cs-control-dock">
                <span className="cs-control-note">{takingControl ? 'You have the mouse and keyboard' : 'Alpha has control'}</span>
                <button
                  className={`cs-button ${takingControl ? 'cs-button-secondary' : 'cs-button-primary'}`}
                  onClick={() => setTakingControl((value) => !value)}
                >
                  {ICONS.cursor}
                  {takingControl ? 'Return control' : 'Take control'}
                </button>
              </div>
            )}
          </div>

          <footer className="cs-stream-footer">
            <span><i className="cs-safety-light" /> Encrypted live view</span>
            <span>Protected by this private link</span>
          </footer>
        </section>

        <aside className="cs-task-panel" aria-label="Task details">
          <div className="cs-task-heading">
            <p className="cs-eyebrow">Current task</p>
            <h1>{session.goal || `Work on ${hostname(session.url)}`}</h1>
            <p className="cs-task-status-copy">{copy.detail}</p>
          </div>

          {error && <div className="cs-inline-error" role="alert">{error}</div>}

          {session.status === 'pending' && (
            <section className="cs-checkpoint cs-checkpoint-start">
              <span className="cs-checkpoint-index">01</span>
              <div>
                <h2>Allow this browser session?</h2>
                <p>Alpha will work only on <strong>{hostname(session.url)}</strong> for this task. Permission expires and cannot be reused.</p>
                <div className="cs-checkpoint-actions">
                  <button className="cs-button cs-button-primary" disabled={acting} onClick={() => void postAction('approve')}>Start task</button>
                  <button className="cs-text-button" disabled={acting} onClick={() => void postAction('cancel')}>Cancel</button>
                </div>
              </div>
            </section>
          )}

          {session.status === 'waiting' && (
            <section className="cs-checkpoint cs-checkpoint-waiting">
              <span className="cs-checkpoint-index">You</span>
              <div>
                <p className="cs-checkpoint-kicker">Alpha paused here</p>
                <h2>{checkpointTitle}</h2>
                <p>{session.handoffMessage || 'Take control and finish the protected step directly in the website. HireAlpha does not receive or store what you type.'}</p>
                <div className="cs-checkpoint-actions">
                  {session.handoffKind === 'payment' && session.paymentUrl ? (
                    <a className="cs-button cs-button-primary" href={session.paymentUrl} target="_blank" rel="noreferrer">Approve with Link</a>
                  ) : !takingControl ? (
                    <button className="cs-button cs-button-primary" onClick={takeControl}>Take control</button>
                  ) : (
                    <button className="cs-button cs-button-primary" disabled={acting} onClick={() => void postAction('resume')}>Done — let Alpha continue</button>
                  )}
                </div>
              </div>
            </section>
          )}

          {session.status === 'done' && (
            <section className="cs-result">
              <p className="cs-eyebrow">Finished</p>
              <p>{session.result || 'The task completed. Alpha will send the result in iMessage.'}</p>
            </section>
          )}

          {session.status === 'failed' && (
            <section className="cs-result cs-result-error">
              <p className="cs-eyebrow">Stopped</p>
              <p>{session.error || 'The browser task could not continue.'}</p>
            </section>
          )}

          <section className="cs-activity">
            <div className="cs-section-title">
              <h2>What’s happening</h2>
              {session.status === 'running' && <span>Live</span>}
            </div>
            <ol className="cs-activity-list">
              {recentSteps.length ? recentSteps.map((step, index) => (
                <li key={`${step.action}-${index}`}>
                  <span className={index === 0 && session.status === 'running' ? 'is-current' : ''} />
                  <div>
                    <strong>{safeStepLabel(step)}</strong>
                    {index === 0 && session.status === 'running' && <small>Working now</small>}
                  </div>
                </li>
              )) : (
                <li>
                  <span className={session.status === 'running' ? 'is-current' : ''} />
                  <div><strong>{session.status === 'pending' ? 'Waiting for permission' : 'Secure browser connected'}</strong></div>
                </li>
              )}
            </ol>
          </section>

          {(session.status === 'running' || session.status === 'waiting') && (
            <button className="cs-stop-button" disabled={acting} onClick={() => void postAction('cancel')}>Stop task</button>
          )}

          <p className="cs-privacy-note">Passwords and verification codes should be entered directly into the live website. They are never shown in the activity log.</p>
        </aside>
      </main>
    </div>
  )
}
