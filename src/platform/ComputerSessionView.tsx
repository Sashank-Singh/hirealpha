import { useEffect, useState, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import './computerSession.css'

interface SessionData {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed'
  kind: string
  url: string
  goal: string | null
  attempts: number
  result: string | null
  error: string | null
  streamUrl: string
  steps: Array<{ action: string; selector?: string; value?: string; ms?: number }>
}

export function ComputerSessionView() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || searchParams.get('t') || ''

  const [session, setSession] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [interactive, setInteractive] = useState(false)
  const [copied, setCopied] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let timer: any = null
    let active = true

    async function fetchSession() {
      if (!sessionId) return
      try {
        const query = token ? `?token=${encodeURIComponent(token)}` : ''
        const res = await fetch(`/api/computer/session/${sessionId}${query}`, {
          headers: { 'Accept': 'application/json' },
        })

        if (res.status === 403) {
          if (active) {
            setForbidden(true)
            setLoading(false)
          }
          return
        }

        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          if (active) {
            setErrorMsg(err.error || `Session error (${res.status})`)
            setLoading(false)
          }
          return
        }

        const data = await res.json()
        if (active && data.ok && data.session) {
          setSession(data.session)
          setLoading(false)

          // Poll periodically while session is active
          if (['pending', 'running'].includes(data.session.status)) {
            timer = setTimeout(fetchSession, 2500)
          }
        }
      } catch (err: any) {
        if (active) {
          setErrorMsg(err.message || 'Failed to connect to session')
          setLoading(false)
        }
      }
    }

    fetchSession()

    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, token])

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const cancelSession = async () => {
    if (!sessionId || !confirm('Stop this computer session?')) return
    try {
      const query = token ? `?token=${encodeURIComponent(token)}` : ''
      await fetch(`/api/computer/session/${sessionId}/cancel${query}`, {
        method: 'POST',
      })
      if (session) {
        setSession({ ...session, status: 'failed', error: 'Cancelled by user' })
      }
    } catch {
      // ignore
    }
  }

  if (forbidden) {
    return (
      <div className="cs-container">
        <div className="cs-locked-screen">
          <div className="cs-locked-box">
            <div className="cs-locked-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </div>
            <h2 className="cs-locked-title">Private Session</h2>
            <p className="cs-locked-desc">
              This computer session belongs to another user. Only the user who initiated it can watch the live screen.
            </p>
            <button className="cs-btn cs-btn-secondary" onClick={() => window.location.href = '/'}>
              Return to HireAlpha
            </button>
          </div>
        </div>
      </div>
    )
  }

  const status = session?.status || (loading ? 'pending' : 'failed')
  const host = session?.url ? (() => {
    try { return new URL(session.url).hostname } catch { return session.url }
  })() : 'Remote Browser'

  return (
    <div className="cs-container">
      {/* Header */}
      <header className="cs-header">
        <div className="cs-header-left">
          <div className="cs-badge-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
          </div>
          <div className="cs-title-group">
            <div className="cs-title">
              Alpha Computer Session
              {sessionId && <span className="cs-session-id">{sessionId.slice(0, 8)}...</span>}
            </div>
          </div>
        </div>

        <div className="cs-header-right">
          <div className={`cs-status-pill ${status}`}>
            <span className="cs-pulse-dot"></span>
            {status}
          </div>

          <button className="cs-btn cs-btn-secondary" onClick={copyLink}>
            {copied ? '✓ Copied' : 'Share Link'}
          </button>

          {['pending', 'running'].includes(status) && (
            <button className="cs-btn cs-btn-danger" onClick={cancelSession}>
              Stop
            </button>
          )}
        </div>
      </header>

      {/* Main Workspace */}
      <main className="cs-main">
        {/* Left Column: Live Screen Card */}
        <section className="cs-screen-card">
          <div className="cs-screen-bar">
            <div className="cs-screen-url" title={session?.url || 'Navigating...'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
              <span>{session?.url || 'Connecting to remote browser...'}</span>
            </div>

            <div className="cs-screen-controls">
              <button
                className={`cs-btn ${interactive ? 'cs-btn-primary' : 'cs-btn-secondary'}`}
                onClick={() => setInteractive(!interactive)}
                title="Toggle user interaction with the remote browser"
              >
                {interactive ? '🕹️ Control Active' : '👁️ Watch Only'}
              </button>

              <button
                className="cs-btn cs-btn-secondary"
                onClick={() => {
                  const elem = iframeRef.current
                  if (elem && elem.requestFullscreen) elem.requestFullscreen()
                }}
                title="Fullscreen"
              >
                ⛶ Fullscreen
              </button>
            </div>
          </div>

          {/* Screen Viewport */}
          <div className="cs-screen-viewport">
            {session?.streamUrl ? (
              <iframe
                ref={iframeRef}
                className="cs-screen-iframe"
                src={session.streamUrl}
                title="Live Browser Screen"
                allow="clipboard-read; clipboard-write"
                style={{ pointerEvents: interactive ? 'auto' : 'none' }}
              />
            ) : (
              <div style={{ color: '#64748b', fontSize: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                <div className="cs-pulse-dot" style={{ width: '12px', height: '12px' }}></div>
                <span>{loading ? 'Initializing virtual desktop...' : (errorMsg || 'Session stream unavailable')}</span>
              </div>
            )}
          </div>
        </section>

        {/* Right Column: Activity Panel */}
        <aside className="cs-side-panel">
          {/* Goal Card */}
          <div className="cs-card">
            <div className="cs-card-title">Active Goal</div>
            <p className="cs-goal-text">
              {session?.goal || 'Autonomous browsing task'}
            </p>
          </div>

          {/* Outcome / Result Card if done */}
          {session?.result && (
            <div className="cs-card" style={{ borderColor: 'rgba(16, 185, 129, 0.3)' }}>
              <div className="cs-card-title" style={{ color: '#34d399' }}>Task Outcome</div>
              <div style={{ fontSize: '13.5px', color: '#e2e8f0', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {session.result}
              </div>
            </div>
          )}

          {session?.error && (
            <div className="cs-card" style={{ borderColor: 'rgba(239, 68, 68, 0.3)' }}>
              <div className="cs-card-title" style={{ color: '#f87171' }}>Error Encountered</div>
              <div style={{ fontSize: '13.5px', color: '#fca5a5', lineHeight: 1.5 }}>
                {session.error}
              </div>
            </div>
          )}

          {/* Live Activity Log */}
          <div className="cs-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="cs-card-title">
              <span>Activity Log</span>
              <span style={{ fontSize: '11px', color: '#64748b' }}>Realtime</span>
            </div>

            <div className="cs-log-list">
              <div className="cs-log-item nav">
                <div className="cs-log-time">00:01</div>
                <div className="cs-log-content">
                  Initialized isolated browser environment for {host}
                </div>
              </div>

              {session?.url && (
                <div className="cs-log-item nav">
                  <div className="cs-log-time">00:02</div>
                  <div className="cs-log-content">
                    Navigated to {session.url}
                  </div>
                </div>
              )}

              {session?.steps?.map((step, idx) => (
                <div key={idx} className="cs-log-item">
                  <div className="cs-log-time">00:{String(idx + 3).padStart(2, '0')}</div>
                  <div className="cs-log-content">
                    {step.action.toUpperCase()} {step.selector ? `on "${step.selector}"` : ''} {step.value ? `with "${step.value}"` : ''}
                  </div>
                </div>
              ))}

              {session?.status === 'running' && (
                <div className="cs-log-item">
                  <div className="cs-log-time">Live</div>
                  <div className="cs-log-content" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span className="cs-pulse-dot" style={{ width: '6px', height: '6px' }}></span>
                    Agent evaluating page elements & inputs...
                  </div>
                </div>
              )}

              {session?.status === 'done' && (
                <div className="cs-log-item done">
                  <div className="cs-log-time">Done</div>
                  <div className="cs-log-content">
                    Completed task successfully
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}
