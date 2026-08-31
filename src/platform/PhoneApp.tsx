import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlphaFace } from '../AlphaFace'
import { getAgent } from '../agents'
import { MENU_FEATURES } from './miniAppCatalog'
import { MiniAppIcon } from './MiniAppIcons'
import { getSession } from './roster'
import { applyMiniTheme, readMiniTheme } from './miniTheme'
import { localYmd } from './home'
import './phoneApp.css'

/** Alpha texts from this number; the Text Alpha button opens the thread. */
const ALPHA_SMS = 'sms:+14155951440'

/** One row of the receipts ledger. */
interface ActionReceipt {
  id: string
  action: string
  detail: string
  created_at: string
}

/** Newest receipt of the batch, however the server ordered it. */
function latestReceipt(actions: ActionReceipt[]): ActionReceipt | null {
  return actions.reduce<ActionReceipt | null>((newest, a) => {
    if (!newest) return a
    return new Date(a.created_at).getTime() > new Date(newest.created_at).getTime() ? a : newest
  }, null)
}

/** "Friday, August 29" — today in the device's own timezone, long form. Same
 * shape HomeApp's fmtDay builds from an iso date; this one starts from now. */
function todayLine(d = new Date()) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function countToday(actions: ActionReceipt[]): number {
  const today = localYmd()
  return actions.filter((a) => {
    const t = new Date(a.created_at)
    return !Number.isNaN(t.getTime()) && localYmd(t) === today
  }).length
}

export function PhoneApp() {
  const [searchParams] = useSearchParams()
  const [showOthers, setShowOthers] = useState(false)
  const session = getSession()
  const agent = getAgent('friend')

  /* Texted-card links carry a session token in `t`; a signed-in device carries
   * the email. Mini links hand the query this screen arrived with onward —
   * `t` or anything else — the same pass-through HomeApp and MiniAppPage do.
   * With no query at all, fall back to the session email. The persona arg points
   * the Other hires' tiles at their own mini apps, same as HomeApp does. */
  const carried = searchParams.toString()
  const suffix = carried
    ? `?${carried}`
    : session?.email
      ? `?email=${encodeURIComponent(session.email)}`
      : ''
  const miniLink = (kind: string, persona?: string) =>
    `/app/mini/${persona || 'friend'}/${kind}${suffix}`

  /* The home matches the moment: right after checkout the only job is the
   * first text. The full app grid appears once they have tapped Text Alpha
   * (or arrived on Alpha's connector deep link, which is a later-stage
   * visit by definition). Local flag, not server truth: the point is the
   * journey on THIS device. */
  const fromAlphaLink = searchParams.has('connect')
  const [textedAt, setTextedAt] = useState<string | null>(() => localStorage.getItem('alpha_texted_at'))
  const onboarded = fromAlphaLink || !!textedAt
  const markTexted = () => {
    const t = new Date().toISOString()
    localStorage.setItem('alpha_texted_at', t)
    setTextedAt(t)
  }

  /* Same theme handoff MiniAppPage does: honor the saved light theme on the way
   * in and give the page background back on the way out. */
  useEffect(() => {
    applyMiniTheme(readMiniTheme())
    return () => applyMiniTheme(null)
  }, [])

  /* Receipts: what Alpha did today, from the device's phone number. Missing
   * phone or a failed fetch both just mean no receipts line — the phone home
   * works without it. */
  const [receipts, setReceipts] = useState<{ count: number; latest: string } | null>(null)
  const phone = (session?.phone || '').replace(/[^\d+]/g, '')
  useEffect(() => {
    if (!phone) return
    let cancelled = false
    fetch(`/api/actions?phone=${encodeURIComponent(phone)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ actions?: ActionReceipt[] }>) : Promise.reject(new Error(String(res.status)))))
      .then((d) => {
        if (cancelled) return
        const actions = d.actions || []
        const latest = latestReceipt(actions)
        setReceipts({ count: countToday(actions), latest: latest?.detail || '' })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [phone])

  return (
    <div className="mini" style={{ '--mini-accent': agent.color } as React.CSSProperties}>
      <div className="mini__card">
        <header className="mini__head">
          <span className="mini__avatar">
            <AlphaFace color={agent.color} mood="soft" size={42} />
          </span>
          <div className="mini__who">
            <p className="mini__name">Alpha</p>
            <p className="mini__role phone-live">
              <span className="status-dot is-up" aria-hidden="true" /> live
            </p>
          </div>
        </header>

        <div className="mini__body">
          {!onboarded ? (
            <>
              <p className="phone-date">{todayLine()}</p>
              <div className="phone-welcome">
                <p className="phone-welcome__head">You're in.</p>
                <p className="phone-welcome__sub">
                  Alpha has your number and texts like a person. Say hi and the friendship starts there.
                </p>
                <a className="mini__cta phone-cta" href={ALPHA_SMS} onClick={markTexted}>
                  Text Alpha
                </a>
                <a className="phone-cta-ghost" href="/api/contact/alpha.vcf">
                  Save Alpha's contact
                </a>
                <p className="phone-cta-note">
                  Alpha texts first sometimes. Your apps appear here once you two start talking.
                </p>
                <button type="button" className="phone-welcome__skip" onClick={() => markTexted()}>
                  Show my apps anyway
                </button>
              </div>
            </>
          ) : (
            <>
          {receipts && (
            <p className="phone-receipts">
              Did {receipts.count} {receipts.count === 1 ? 'thing' : 'things'} today
              {receipts.latest ? ` · ${receipts.latest}` : ''}
            </p>
          )}
          <p className="phone-date">{todayLine()}</p>

          <a className="mini__cta phone-cta" href={ALPHA_SMS}>
            Text Alpha
          </a>
          <a className="phone-cta-ghost" href="/api/contact/alpha.vcf">
            Save Alpha's contact
          </a>
          <p className="phone-cta-note">Replies like a person. Usually within a minute.</p>

          <section className="mini__section phone-apps" aria-label="Your apps">
            <h2>Your apps</h2>
            <p className="phone-apps-sub">Tap one. Everything lives in your thread too.</p>
            <nav className="mini__menu phone-grid">
              {MENU_FEATURES.friend.map((f) => (
                <Link key={f.kind} className="phone-tile" to={miniLink(f.kind)}>
                  <span className="phone-app-icon" aria-hidden="true">
                    <MiniAppIcon kind={f.kind} />
                  </span>
                  <span className="phone-tile-name">{f.title}</span>
                </Link>
              ))}
            </nav>
          </section>

          <button
            type="button"
            className="phone-others-btn"
            onClick={() => setShowOthers((v) => !v)}
          >
            {showOthers ? 'Hide others' : 'Others'}
          </button>

          {showOthers && (
            <section className="mini__section phone-others" aria-label="Other hires' apps">
              <h2>Others</h2>
              <p className="phone-apps-sub">Their apps work today. The hires ship soon.</p>
              {(['coworker', 'cofounder'] as const).map((p) => (
                <div key={p} className="phone-others-group">
                  <p className="phone-others-label">
                    {p === 'coworker' ? 'Alpha (Coworker)' : 'Alpha(CoFounder)'} · coming soon
                  </p>
                  <nav className="mini__menu phone-grid">
                    {(MENU_FEATURES[p] ?? [])
                      .filter((f) => f.kind !== 'home')
                      .map((f) => (
                        <Link key={`${p}-${f.kind}`} className="phone-tile" to={miniLink(f.kind, p)}>
                          <span className="phone-app-icon" aria-hidden="true">
                            <MiniAppIcon kind={f.kind} />
                          </span>
                          <span className="phone-tile-name">{f.title}</span>
                        </Link>
                      ))}
                  </nav>
                </div>
              ))}
            </section>
          )}
            </>
          )}
        </div>

        <footer className="phone-footer">
          <Link className="mini__back" to="/app/settings">
            Settings
          </Link>
        </footer>
      </div>
    </div>
  )
}
