import { useEffect, useState, useRef } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
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

type ScenarioType = 'linkedin' | 'amazon' | 'form'

interface StepAction {
  name: string
  desc: string
  type: 'navigate' | 'extract' | 'focus' | 'type' | 'auth' | 'click' | 'submit'
  cursor: { x: number; y: number }
  selector?: string
  value?: string
}

export function ComputerSessionView() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || searchParams.get('t') || ''

  const [session, setSession] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [interactive, setInteractive] = useState(false)
  const [showIframe, setShowIframe] = useState(false)
  const [copied, setCopied] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (!sessionId || sessionId === 'session_linkedin' || sessionId === 'demo') return
    let active = true
    setLoading(true)
    const query = token ? `?token=${encodeURIComponent(token)}` : ''
    fetch(`/api/computer/session/${sessionId}${query}`)
      .then((res) => {
        if (res.status === 403) {
          if (active) setForbidden(true)
          return null
        }
        return res.json()
      })
      .then((data) => {
        if (active && data?.ok && data.session) {
          setSession(data.session)
          if (data.session.streamUrl) setShowIframe(true)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [sessionId, token])

  // Interactive Emulation State for browser-use & forms
  const [scenario, setScenario] = useState<ScenarioType>('linkedin')
  const [stepIdx, setStepIdx] = useState(1)
  const [isPlaying, setIsPlaying] = useState(false)
  const [vaultModal, setVaultModal] = useState(false)
  const [vaultAuthorized, setVaultAuthorized] = useState(false)
  const [cursorClicking, setCursorClicking] = useState(false)

  // Field states
  const [typedUsername, setTypedUsername] = useState('')
  const [typedPassword, setTypedPassword] = useState('')
  const [amazonQuantity, setAmazonQuantity] = useState('1')
  const [amazonInCart, setAmazonInCart] = useState(false)
  const [amazonCheckoutStage, setAmazonCheckoutStage] = useState<'product' | 'cart' | 'checkout'>('product')
  const [quotesUsername, setQuotesUsername] = useState('')
  const [quotesPassword, setQuotesPassword] = useState('')
  const [formSubmitted, setFormSubmitted] = useState(false)

  // Real-time activity logs
  const [logs, setLogs] = useState<Array<{ time: string; type: string; msg: string; tag?: string }>>([
    { time: '00:01', type: 'cs-nav-item', msg: 'Initialized isolated browser session with browser-use v0.13.10', tag: 'INIT' },
    { time: '00:02', type: 'cs-nav-item', msg: 'Anti-bot stealth & user-agent spoofing active', tag: 'STEALTH' },
  ])

  // Scenario step configurations
  const linkedinSteps: StepAction[] = [
    { name: 'Navigate', desc: 'Navigating to https://www.linkedin.com/login', type: 'navigate', cursor: { x: 50, y: 15 } },
    { name: 'Index DOM', desc: 'browser-use extracted 4 interactive form elements: [1] #username, [2] #password, [3] #remember, [4] #submit', type: 'extract', cursor: { x: 50, y: 28 } },
    { name: 'Select Username', desc: 'Moving cursor to element [1] input#username', type: 'focus', cursor: { x: 45, y: 44 }, selector: '#username' },
    { name: 'Type Username', desc: 'Typed "sashank@hirealpha.chat" into #username field', type: 'type', cursor: { x: 55, y: 44 }, selector: '#username', value: 'sashank@hirealpha.chat' },
    { name: 'Select Password', desc: 'Moving cursor to element [2] input#password', type: 'focus', cursor: { x: 45, y: 55 }, selector: '#password' },
    { name: 'Vault Security Gate', desc: 'Protected credential detected. Paused execution for 1Password Vault token authorization', type: 'auth', cursor: { x: 50, y: 55 }, selector: '#password' },
    { name: 'Inject Vault Token', desc: 'Received credential token from 1Password Vault. Injected password securely', type: 'type', cursor: { x: 50, y: 55 }, selector: '#password', value: '••••••••••••' },
    { name: 'Click Sign In', desc: 'Moved cursor to [4] button#submit and performed mouse click', type: 'click', cursor: { x: 50, y: 72 }, selector: 'button[type=submit]' },
    { name: 'Complete', desc: 'Session authenticated. Redirecting to feed with user session intact', type: 'submit', cursor: { x: 50, y: 72 } },
  ]

  const amazonSteps: StepAction[] = [
    { name: 'Navigate', desc: 'Navigating to https://www.amazon.com/dp/B08XYZ_SOCKS', type: 'navigate', cursor: { x: 50, y: 15 } },
    { name: 'Index DOM', desc: 'browser-use indexed buy-box: [1] select#quantity, [2] button#add-to-cart, [3] button#buy-now', type: 'extract', cursor: { x: 60, y: 35 } },
    { name: 'Select Quantity', desc: 'Moving cursor to element [1] select#quantity (requested 10 pairs of socks)', type: 'focus', cursor: { x: 65, y: 44 }, selector: '#quantity' },
    { name: 'Set Qty 10', desc: 'Selected option value "10" (10-pack bundle, $189.90)', type: 'type', cursor: { x: 65, y: 44 }, selector: '#quantity', value: '10' },
    { name: 'Click Add to Cart', desc: 'Clicked [2] button#add-to-cart with human-like mouse action', type: 'click', cursor: { x: 65, y: 56 }, selector: '#add-to-cart' },
    { name: 'Proceed to Checkout', desc: 'Cart loaded. Clicked [3] Proceed to checkout button', type: 'click', cursor: { x: 75, y: 62 }, selector: '#checkout' },
    { name: 'Hold Before Charge', desc: 'Reached final checkout summary ($189.90). Staged without charging. Created approval card for user permission', type: 'submit', cursor: { x: 50, y: 50 } },
  ]

  const formSteps: StepAction[] = [
    { name: 'Navigate', desc: 'Navigating to https://quotes.toscrape.com/login', type: 'navigate', cursor: { x: 50, y: 20 } },
    { name: 'Index Form', desc: 'browser-use detected shadow DOM fields: [1] #username, [2] #password, [3] input[type=submit]', type: 'extract', cursor: { x: 50, y: 35 } },
    { name: 'Fill Username', desc: 'Typed "alpha_agent" into element [1] input#username', type: 'type', cursor: { x: 45, y: 45 }, selector: '#username', value: 'alpha_agent' },
    { name: 'Fill Password', desc: 'Typed secret password into element [2] input#password', type: 'type', cursor: { x: 45, y: 56 }, selector: '#password', value: '••••••••••••' },
    { name: 'Click Submit', desc: 'Clicked [3] input[type=submit] button. Form submission dispatched', type: 'click', cursor: { x: 45, y: 68 }, selector: 'input[type=submit]' },
    { name: 'Done', desc: 'HTTP 200 OK. Successfully logged in and extracted user session cookie', type: 'submit', cursor: { x: 50, y: 50 } },
  ]

  const activeSteps = scenario === 'linkedin' ? linkedinSteps : scenario === 'amazon' ? amazonSteps : formSteps
  const currentStepData = activeSteps[Math.min(stepIdx - 1, activeSteps.length - 1)]

  // Apply step mutations
  const executeStep = (targetStep: number) => {
    if (targetStep < 1 || targetStep > activeSteps.length) return
    setStepIdx(targetStep)
    const cur = activeSteps[targetStep - 1]

    // Cursor click pulse
    if (cur.type === 'click' || cur.type === 'focus') {
      setCursorClicking(true)
      setTimeout(() => setCursorClicking(false), 300)
    }

    // Apply scenario-specific visual changes
    if (scenario === 'linkedin') {
      if (targetStep >= 4) setTypedUsername('sashank@hirealpha.chat')
      else setTypedUsername('')

      if (targetStep === 6 && !vaultAuthorized) {
        setVaultModal(true)
        setIsPlaying(false)
      }

      if (targetStep >= 7) setTypedPassword('••••••••••••')
      else setTypedPassword('')

      if (targetStep >= 8) setFormSubmitted(true)
      else setFormSubmitted(false)
    } else if (scenario === 'amazon') {
      if (targetStep >= 4) setAmazonQuantity('10')
      else setAmazonQuantity('1')

      if (targetStep >= 5) setAmazonInCart(true)
      else setAmazonInCart(false)

      if (targetStep >= 6) setAmazonCheckoutStage('checkout')
      else if (targetStep === 5) setAmazonCheckoutStage('cart')
      else setAmazonCheckoutStage('product')
    } else if (scenario === 'form') {
      if (targetStep >= 3) setQuotesUsername('alpha_agent')
      else setQuotesUsername('')

      if (targetStep >= 4) setQuotesPassword('••••••••••••')
      else setQuotesPassword('')

      if (targetStep >= 5) setFormSubmitted(true)
      else setFormSubmitted(false)
    }

    // Append log
    const now = new Date()
    const timeStr = `${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    const itemClass = cur.type === 'auth' ? 'cs-auth-item' : cur.type === 'click' ? 'cs-click-item' : cur.type === 'submit' ? 'done' : 'cs-nav-item'
    setLogs((prev) => [
      ...prev,
      { time: timeStr, type: itemClass, msg: cur.desc, tag: cur.type.toUpperCase() }
    ])
  }

  // Auto-play timer
  useEffect(() => {
    if (!isPlaying) return
    if (stepIdx >= activeSteps.length) {
      setIsPlaying(false)
      return
    }

    const timer = setTimeout(() => {
      executeStep(stepIdx + 1)
    }, 1600)

    return () => clearTimeout(timer)
  }, [isPlaying, stepIdx, activeSteps.length])

  // Reset scenario
  const switchScenario = (sc: ScenarioType) => {
    setScenario(sc)
    setStepIdx(1)
    setIsPlaying(false)
    setVaultModal(false)
    setVaultAuthorized(false)
    setTypedUsername('')
    setTypedPassword('')
    setAmazonQuantity('1')
    setAmazonInCart(false)
    setAmazonCheckoutStage('product')
    setQuotesUsername('')
    setQuotesPassword('')
    setFormSubmitted(false)

    const initialUrl = sc === 'linkedin' ? 'https://www.linkedin.com/login' : sc === 'amazon' ? 'https://www.amazon.com/dp/B08XYZ_SOCKS' : 'https://quotes.toscrape.com/login'
    setLogs([
      { time: '00:01', type: 'cs-nav-item', msg: `Switched scenario to ${sc.toUpperCase()}`, tag: 'INIT' },
      { time: '00:02', type: 'cs-nav-item', msg: `Navigating to ${initialUrl}`, tag: 'NAVIGATE' },
    ])
  }

  const approveVault = () => {
    setVaultAuthorized(true)
    setVaultModal(false)
    executeStep(7)
    setIsPlaying(true)
  }

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const activeUrl = scenario === 'linkedin'
    ? 'https://www.linkedin.com/login'
    : scenario === 'amazon'
    ? (amazonCheckoutStage === 'checkout' ? 'https://www.amazon.com/checkout' : 'https://www.amazon.com/dp/B08XYZ_SOCKS')
    : 'https://quotes.toscrape.com/login'

  const activeGoal = scenario === 'linkedin'
    ? 'Navigate to LinkedIn login, locate credentials fields with browser-use, and request password from 1Password Vault.'
    : scenario === 'amazon'
    ? 'Order 10 pairs of crew socks: select quantity 10, add to cart, proceed to checkout, and halt before charge for user spend approval.'
    : 'Navigate to quotes.toscrape.com/login, fill username and password, click submit, and verify authenticated session.'

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
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#94a3b8' }}>
              <span className="cs-pulse-dot" style={{ width: '6px', height: '6px' }}></span>
              <span>Syncing session...</span>
            </div>
          )}

          <div className={`cs-status-pill ${vaultModal ? 'pending' : (stepIdx === activeSteps.length ? 'done' : 'running')}`}>
            <span className="cs-pulse-dot"></span>
            {vaultModal ? 'WAITING FOR VAULT' : (stepIdx === activeSteps.length ? 'COMPLETED' : (isPlaying ? 'RUNNING' : 'ACTIVE'))}
          </div>

          <button className="cs-btn cs-btn-secondary" onClick={copyLink}>
            {copied ? '✓ Copied' : 'Share Link'}
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="cs-main">
        {/* Left Column: Live Interactive Browser Screen */}
        <section className="cs-screen-card">
          <div className="cs-canvas-wrapper">
            {/* Browser Chrome Header */}
            <div className="cs-browser-chrome">
              <div className="cs-traffic-lights">
                <span className="cs-traffic-dot red"></span>
                <span className="cs-traffic-dot yellow"></span>
                <span className="cs-traffic-dot green"></span>
              </div>

              <div className="cs-browser-nav-btns">
                <button className="cs-nav-btn" title="Back">‹</button>
                <button className="cs-nav-btn" title="Forward">›</button>
                <button className="cs-nav-btn" title="Reload" onClick={() => executeStep(1)}>↻</button>
              </div>

              <div className="cs-url-bar">
                <span className="cs-url-lock">🔒</span>
                <span>{activeUrl}</span>
              </div>

              <div className="cs-engine-badge">
                <span>⚡ browser-use v0.13</span>
              </div>
            </div>

            {/* Execution Controls Toolbar */}
            <div className="cs-action-toolbar">
              <div className="cs-scenario-tabs">
                <button
                  className={`cs-scenario-tab ${scenario === 'linkedin' ? 'active' : ''}`}
                  onClick={() => switchScenario('linkedin')}
                >
                  LinkedIn Login + Vault
                </button>
                <button
                  className={`cs-scenario-tab ${scenario === 'amazon' ? 'active' : ''}`}
                  onClick={() => switchScenario('amazon')}
                >
                  Amazon 10-Pack Socks
                </button>
                <button
                  className={`cs-scenario-tab ${scenario === 'form' ? 'active' : ''}`}
                  onClick={() => switchScenario('form')}
                >
                  Web Form Execution
                </button>
              </div>

              <div className="cs-play-controls">
                <button
                  className="cs-play-btn"
                  onClick={() => setIsPlaying(!isPlaying)}
                >
                  {isPlaying ? '⏸ Pause' : '▶ Run Live Execution'}
                </button>

                <button
                  className="cs-btn cs-btn-secondary"
                  onClick={() => executeStep(Math.min(stepIdx + 1, activeSteps.length))}
                  disabled={stepIdx >= activeSteps.length}
                >
                  ⏭ Step ({stepIdx}/{activeSteps.length})
                </button>

                <button
                  className="cs-btn cs-btn-secondary"
                  onClick={() => executeStep(1)}
                  title="Reset to Step 1"
                >
                  ↺ Reset
                </button>

                {session?.streamUrl && (
                  <button
                    className="cs-btn cs-btn-secondary"
                    onClick={() => setShowIframe(!showIframe)}
                  >
                    {showIframe ? 'Switch to AI View' : 'Live VNC Stream'}
                  </button>
                )}
              </div>
            </div>

            {/* Browser Page Stage / Viewport */}
            <div className="cs-page-stage">
              {showIframe && session?.streamUrl ? (
                <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                  <iframe
                    ref={iframeRef}
                    className="cs-screen-iframe"
                    src={session.streamUrl}
                    title="Live Remote Browser"
                    allow="clipboard-read; clipboard-write"
                    style={{ width: '100%', height: '100%', border: 'none', pointerEvents: interactive ? 'auto' : 'none' }}
                  />
                  <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 10 }}>
                    <button
                      className={`cs-btn ${interactive ? 'cs-btn-primary' : 'cs-btn-secondary'}`}
                      onClick={() => setInteractive(!interactive)}
                    >
                      {interactive ? '🕹️ Control Active' : '👁️ Watch Only'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
              {/* Animated AI Agent Pointer Cursor */}
              <div
                className="cs-agent-cursor"
                style={{
                  left: `${currentStepData.cursor.x}%`,
                  top: `${currentStepData.cursor.y}%`,
                  transform: cursorClicking ? 'scale(0.85)' : 'scale(1)',
                }}
              >
                <svg className="cs-cursor-arrow" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M4 0l16 12-7.5 1.5 4.5 9-3 1.5-4.5-9-5.5 5.5v-20.5z" />
                </svg>
                <span className="cs-cursor-badge">
                  {isPlaying ? 'Agent Typing/Clicking...' : 'browser-use Agent'}
                </span>
              </div>

              {/* Scenario 1: LinkedIn Login */}
              {scenario === 'linkedin' && (
                <div className="cs-li-container">
                  <div className="cs-li-logo">
                    <span>Linked</span>
                    <span style={{ background: '#0a66c2', color: '#fff', borderRadius: '4px', padding: '0 4px' }}>in</span>
                  </div>
                  <h1 className="cs-li-title">Sign in</h1>
                  <p className="cs-li-sub">Stay updated on your professional world</p>

                  <div className="cs-li-form">
                    {/* Username field [1] */}
                    <div className="cs-li-field">
                      <label className="cs-li-label">Email or Phone</label>
                      <div className={`cs-bu-box ${stepIdx >= 2 ? 'indexed' : ''} ${stepIdx === 3 || stepIdx === 4 ? 'focused' : ''}`}>
                        {stepIdx >= 2 && <span className="cs-bu-tag">[1] #username</span>}
                        <input
                          type="text"
                          className="cs-li-input"
                          placeholder="Email or phone"
                          value={typedUsername}
                          readOnly
                        />
                      </div>
                    </div>

                    {/* Password field [2] */}
                    <div className="cs-li-field">
                      <label className="cs-li-label">Password</label>
                      <div className={`cs-bu-box ${stepIdx >= 2 ? 'indexed' : ''} ${stepIdx === 5 || stepIdx === 6 || stepIdx === 7 ? 'focused' : ''}`}>
                        {stepIdx >= 2 && <span className="cs-bu-tag">[2] #password</span>}
                        <input
                          type="password"
                          className="cs-li-input"
                          placeholder="Password"
                          value={typedPassword}
                          readOnly
                        />
                      </div>
                    </div>

                    {/* Remember me [3] */}
                    <div className="cs-bu-box indexed" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                      {stepIdx >= 2 && <span className="cs-bu-tag">[3] #remember</span>}
                      <input type="checkbox" id="remember" defaultChecked />
                      <label htmlFor="remember" style={{ fontSize: '13px', color: '#4b5563' }}>Keep me logged in</label>
                    </div>

                    {/* Submit Button [4] */}
                    <div className={`cs-bu-box ${stepIdx >= 2 ? 'indexed' : ''} ${stepIdx >= 8 ? 'clicked' : ''}`}>
                      {stepIdx >= 2 && <span className="cs-bu-tag">[4] button#submit</span>}
                      <button className="cs-li-btn" style={{ width: '100%' }}>
                        {formSubmitted ? '✓ Authenticated' : (stepIdx === 8 ? 'Signing in...' : 'Sign in')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Scenario 2: Amazon Socks Order (10 Pairs) */}
              {scenario === 'amazon' && (
                <div className="cs-amz-container">
                  <div className="cs-amz-image-box">
                    <span>🧦</span>
                    <span style={{ fontSize: '12px', color: '#64748b', marginTop: '8px' }}>10-Pair Cotton Crew</span>
                  </div>

                  <div className="cs-amz-details">
                    <h2 className="cs-amz-title">Hanes Men's Cushion Crew Socks, 10-Pair Pack, Black/White</h2>
                    <div style={{ color: '#007185', fontSize: '13px', marginBottom: '8px' }}>★★★★★ 4.6 (42,819 ratings)</div>
                    <div className="cs-amz-price">$18.99 <span style={{ fontSize: '13px', color: '#565959', fontWeight: 'normal' }}>($1.90 / Pair)</span></div>

                    <div className="cs-amz-qty-row">
                      <label style={{ fontSize: '13px', fontWeight: 600 }}>Quantity:</label>
                      <div className={`cs-bu-box ${stepIdx >= 2 ? 'indexed' : ''} ${stepIdx === 3 || stepIdx === 4 ? 'focused' : ''}`}>
                        {stepIdx >= 2 && <span className="cs-bu-tag">[1] select#qty</span>}
                        <select
                          value={amazonQuantity}
                          onChange={(e) => setAmazonQuantity(e.target.value)}
                          style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #d5d9d9', fontSize: '13px', background: '#f0f2f2' }}
                        >
                          <option value="1">Qty: 1</option>
                          <option value="5">Qty: 5</option>
                          <option value="10">Qty: 10 (Pack of 100 socks)</option>
                        </select>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
                      <div className={`cs-bu-box ${stepIdx >= 2 ? 'indexed' : ''} ${stepIdx === 5 ? 'clicked' : ''}`}>
                        {stepIdx >= 2 && <span className="cs-bu-tag">[2] button#add-to-cart</span>}
                        <button className="cs-amz-btn">
                          🛒 {amazonInCart ? '✓ 10 Packs Added to Cart' : 'Add to Cart'}
                        </button>
                      </div>

                      {amazonInCart && (
                        <div className={`cs-bu-box indexed ${stepIdx === 6 ? 'clicked' : ''}`}>
                          <span className="cs-bu-tag">[3] button#checkout</span>
                          <button className="cs-amz-btn" style={{ background: '#ffa41c', borderColor: '#ff8f00' }}>
                            Proceed to checkout (10 items: $189.90)
                          </button>
                        </div>
                      )}
                    </div>

                    {stepIdx === 7 && (
                      <div style={{ marginTop: '20px', padding: '14px', background: '#ecfdf5', border: '1px solid #10b981', borderRadius: '8px' }}>
                        <div style={{ color: '#065f46', fontWeight: 700, fontSize: '13.5px' }}>
                          ✓ Staged At Checkout — Awaiting User Payment Authorization
                        </div>
                        <div style={{ color: '#047857', fontSize: '12.5px', marginTop: '4px' }}>
                          Cart subtotal: $189.90. Estimated tax & shipping: Calculated at checkout. No charge made yet.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Scenario 3: Quotes to Scrape Login */}
              {scenario === 'form' && (
                <div className="cs-li-container" style={{ background: '#ffffff', border: '1px solid #e2e8f0' }}>
                  <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 16px', color: '#1e293b' }}>Quotes to Scrape Login</h2>
                  <div className="cs-li-form">
                    <div className="cs-li-field">
                      <label className="cs-li-label">Username</label>
                      <div className={`cs-bu-box indexed ${stepIdx === 3 ? 'focused' : ''}`}>
                        <span className="cs-bu-tag">[1] #username</span>
                        <input type="text" className="cs-li-input" value={quotesUsername} readOnly placeholder="Username" />
                      </div>
                    </div>

                    <div className="cs-li-field">
                      <label className="cs-li-label">Password</label>
                      <div className={`cs-bu-box indexed ${stepIdx === 4 ? 'focused' : ''}`}>
                        <span className="cs-bu-tag">[2] #password</span>
                        <input type="password" className="cs-li-input" value={quotesPassword} readOnly placeholder="Password" />
                      </div>
                    </div>

                    <div className={`cs-bu-box indexed ${stepIdx === 5 ? 'clicked' : ''}`}>
                      <span className="cs-bu-tag">[3] input[type=submit]</span>
                      <button className="cs-li-btn" style={{ background: '#3b82f6', width: '100%' }}>
                        {formSubmitted ? '✓ Login Success' : 'Login'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* 1Password / Vault Overlay Modal */}
              {vaultModal && (
                <div className="cs-vault-modal">
                  <div className="cs-vault-icon-wrap">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                    </svg>
                  </div>
                  <h3 className="cs-vault-title">1Password Vault Required</h3>
                  <p className="cs-vault-text">
                    Alpha reached a protected password input on <strong>linkedin.com</strong>.
                    To safeguard your credentials, Alpha never stores raw passwords and requires an authorized Vault token.
                  </p>
                  <div className="cs-vault-actions">
                    <Link
                      to="/app/hires/friend?vault=1"
                      className="cs-vault-btn-primary"
                      target="_blank"
                    >
                      <span>🔑</span>
                      <span>Open 1Password Vault Settings</span>
                    </Link>
                    <button
                      className="cs-vault-btn-secondary"
                      onClick={approveVault}
                    >
                      Authorize & Autofill Password
                    </button>
                  </div>
                </div>
              )}
                </>
              )}
            </div>
          </div>
        </section>

        {/* Right Column: Activity Panel */}
        <aside className="cs-side-panel">
          {/* Active Goal */}
          <div className="cs-card">
            <div className="cs-card-title">Active Goal</div>
            <p className="cs-goal-text">{activeGoal}</p>
          </div>

          {/* Current Step Banner */}
          <div className="cs-card" style={{ borderColor: 'rgba(59, 130, 246, 0.3)' }}>
            <div className="cs-card-title" style={{ color: '#60a5fa' }}>Current Execution Step</div>
            <div style={{ fontSize: '13px', color: '#e2e8f0', lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, marginBottom: '4px', color: '#93c5fd' }}>
                Step {stepIdx} of {activeSteps.length}: {currentStepData.name}
              </div>
              <div style={{ color: '#94a3b8' }}>{currentStepData.desc}</div>
            </div>
          </div>

          {/* Live Activity Log */}
          <div className="cs-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="cs-card-title">
              <span>Activity Log</span>
              <span style={{ fontSize: '11px', color: '#64748b' }}>Realtime</span>
            </div>

            <div className="cs-log-list">
              {logs.map((log, idx) => (
                <div key={idx} className={`cs-log-item ${log.type}`}>
                  <div className="cs-log-time">{log.time}</div>
                  <div className="cs-log-content">
                    {log.tag && (
                      <span style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: '3px',
                        background: 'rgba(255,255,255,0.08)',
                        marginRight: '6px',
                        fontFamily: 'monospace'
                      }}>
                        {log.tag}
                      </span>
                    )}
                    {log.msg}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}
