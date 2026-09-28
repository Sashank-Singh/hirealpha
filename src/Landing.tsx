import { motion } from 'framer-motion'
import { useState, useEffect, useCallback, useRef, type FormEvent, type CSSProperties } from 'react'
import { AlphaFace } from './AlphaFace'
import { AGENTS, PhoneDemo, type AgentId } from './PhoneDemo'
import { Invites } from './marketing/Invites'
import { Pricing } from './marketing/Pricing'
import { ShareButton } from './marketing/ShareButton'
import { getSession, signOut } from './platform/roster'
import { track } from './track'
import { GreatestHits } from './marketing/GreatestHits'
import './landing-stage.css'

const ACTIONS = [
  {
    who: 'Alpha',
    color: '#2a6f7a',
    tool: 'Messages',
    text: 'Checked you in for AA248. Boarding pass is below. Flight is on time.',
  },
  {
    who: 'Alpha (Coworker)',
    color: '#3b5bdb',
    tool: 'Gmail',
    text: 'Priya\'s invoice says 4,000. The PO says 3,500. The reply is drafted in Approve and send.',
  },
  {
    who: 'Alpha(CoFounder)',
    color: '#8b4513',
    tool: 'Notion',
    text: 'Overnight: two investor replies, both want the deck Thursday. The draft is in Investor note, waiting on you.',
  },
  {
    who: 'Alpha',
    color: '#2a6f7a',
    tool: 'Maps',
    text: 'Traffic adds 40 minutes right now. Leave by 5:20 and you still make the 6:30.',
  },
]

const VOICES = [
  { who: 'Alpha', text: 'Checked you in. Boarding pass is below. Flight is on time.' },
  { who: 'Alpha (Coworker)', text: 'Jordan said Thursday. review is on the calendar at 2:30' },
  { who: 'Alpha(CoFounder)', text: 'runway says 9 months. the 18k site is a costume' },
  { who: 'Alpha', text: 'You are 5 minutes from the dentist and it starts in 30.' },
  { who: 'Alpha (Coworker)', text: 'Priya answered about the specs. draft is waiting for your OK' },
  { who: 'Alpha(CoFounder)', text: 'two investor replies overnight. both want the deck thursday. draft is ready' },
]

const FAQS: { question: string; answer: string }[] = [
  {
    question: 'Is this iPhone or Mac only?',
    answer:
      'Yes for now. Hires live in Apple Messages, so you need an iPhone or Mac that can text SMS or iMessage numbers.',
  },
  {
    question: 'Can I hire just one?',
    answer:
      'Yes. Start with Alpha the Friend, add the others when they ship. Or take all three at once for $39.',
  },
  {
    question: 'When do connectors unlock?',
    answer:
      'They are live. Gmail, Calendar, Maps, Slack, Linear, and the rest connect from Settings so the hire can use them in texts.',
  },
  {
    question: 'What do you do with my texts?',
    answer:
      'We do not sell your conversations. Threads stay with your hires, and you’ll control what each one can see once you connect its tools.',
  },
  {
    question: 'What happens after I join the waitlist?',
    answer:
      'Alpha texts you within a minute. Answer three quick questions and the relationship starts. No charge until you actually hire.',
  },
]



const HIRE_APPS: Record<AgentId, { kind: string; title: string; blurb: string }[]> = {
  friend: [
    { kind: 'digest', title: 'Brief', blurb: 'Your day in one look. Meetings, mail that needs you, tonight.' },
    { kind: 'home', title: 'Home', blurb: 'Today, the next eight hours, and receipts.' },
    { kind: 'nutrition', title: 'Nutrition', blurb: 'Text what you ate. Macros log themselves.' },
    { kind: 'workout_log', title: 'Workout', blurb: 'Home or gym program. Log when done.' },
    { kind: 'sleep_tracker', title: 'Sleep', blurb: 'Last night and the week.' },
    { kind: 'habit_streak', title: 'Habits', blurb: 'Today and the streak.' },
    { kind: 'spending_snapshot', title: 'Spending', blurb: "This week's budget and where it went." },
    { kind: 'networking_crm', title: 'People', blurb: 'Who you are overdue to text.' },
    { kind: 'pick_night', title: 'Tonight', blurb: 'Places to eat or hang. Maps powered.' },
  ],
  coworker: [
    { kind: 'digest', title: 'Brief', blurb: 'Your workday in one look. Meetings, mail, standup ready.' },
    { kind: 'home', title: 'Home', blurb: 'Today, the next eight hours, and receipts.' },
    { kind: 'meeting_mode', title: 'Meeting mode', blurb: 'Prep before the meeting. Recap after.' },
    { kind: 'approve_send', title: 'Approve and send', blurb: 'Alpha drafts the email. You read it. Then it sends.' },
    { kind: 'pick_slot', title: 'Pick a slot', blurb: 'Every free time side by side. Tap one and invites go out.' },
    { kind: 'linear_triage', title: 'Linear triage', blurb: 'Your issue backlog, sorted by what matters.' },
    { kind: 'standup_paste', title: 'Standup', blurb: 'Paste messy notes. Get tight standup bullets.' },
  ],
  cofounder: [
    { kind: 'digest', title: 'Brief', blurb: 'Company in one look. Pipeline moves, investor mail, the open decision.' },
    { kind: 'home', title: 'Home', blurb: 'Today, the next eight hours, and receipts.' },
    { kind: 'pipeline_board', title: 'Pipeline', blurb: 'Companies, openings, and investors on one board. Move each one along.' },
    { kind: 'decision_ledger', title: 'Decisions', blurb: 'The call you made, and why. Revisit it when it matters.' },
    { kind: 'networking_crm', title: 'People', blurb: 'Who you met, and who is overdue.' },
    { kind: 'approve_investor_note', title: 'Investor note', blurb: 'The monthly update, reviewed before it goes out.' },
    { kind: 'hire_decision', title: 'Hire decision', blurb: 'Should we hire them? The case, side by side.' },
  ],
}

function AppDeck({ hire }: { hire: AgentId }) {
  const apps = HIRE_APPS[hire]
  const scroller = useRef<HTMLDivElement>(null)
  const [i, setI] = useState(0)

  useEffect(() => {
    setI(0)
    scroller.current?.scrollTo({ left: 0 })
  }, [hire])

  const go = useCallback((n: number) => {
    const next = Math.max(0, Math.min(apps.length - 1, n))
    const el = scroller.current
    const card = el?.children[next] as HTMLElement | undefined
    card?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    setI(next)
  }, [apps.length])

  function onScroll() {
    const el = scroller.current
    if (!el) return
    const mid = el.scrollLeft + el.clientWidth / 2
    let best = 0
    let dist = Infinity
    Array.from(el.children).forEach((node, idx) => {
      const card = node as HTMLElement
      const cx = card.offsetLeft + card.offsetWidth / 2
      const d = Math.abs(cx - mid)
      if (d < dist) {
        dist = d
        best = idx
      }
    })
    setI(best)
  }

  return (
    <div className="kit-deck">
      <div
        ref={scroller}
        className="kit-deck__track"
        onScroll={onScroll}
        tabIndex={0}
        role="list"
        aria-label="Mini apps"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault()
            go(i + 1)
          }
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            go(i - 1)
          }
        }}
      >
        {apps.map((app, n) => (
          <article
            key={`${hire}-${app.kind}`}
            className={`kit-card${n === i ? ' kit-card--on' : ''}`}
            role="listitem"
            aria-current={n === i}
          >
            <strong>{app.title}</strong>
            <p>{app.blurb}</p>
          </article>
        ))}
      </div>
      <div className="kit-deck__nav">
        <button
          type="button"
          className="kit-deck__btn"
          aria-label="Previous app"
          disabled={i === 0}
          onClick={() => go(i - 1)}
        >
          ←
        </button>
        <p>
          {String(i + 1).padStart(2, '0')} / {String(apps.length).padStart(2, '0')}
        </p>
        <button
          type="button"
          className="kit-deck__btn"
          aria-label="Next app"
          disabled={i === apps.length - 1}
          onClick={() => go(i + 1)}
        >
          →
        </button>
      </div>
    </div>
  )
}

function Apps({
  hire,
  onPick,
}: {
  hire: AgentId
  onPick: (id: AgentId) => void
}) {
  return (
    <section className="kit section" id="apps" aria-labelledby="apps-heading">
      <div className="kit__intro container">
        <p className="deed__eyebrow">In Messages</p>
        <h2 id="apps-heading">Apps they open from a text.</h2>
        <p>Swipe through. Nutrition, Today, Home, and the rest live in the thread.</p>
      </div>
      <div className="kit__hires" role="tablist" aria-label="Apps by hire">
        {AGENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={hire === a.id}
            className={`kit-hire${hire === a.id ? ' kit-hire--on' : ''}`}
            style={{ '--tab': a.color } as CSSProperties}
            onClick={() => onPick(a.id)}
          >
            <AlphaFace color={a.color} mood={a.mood} size={22} />
            {a.name}
          </button>
        ))}
      </div>
      <AppDeck hire={hire} />
    </section>
  )
}

function Actions() {
  return (
    <section className="deed section" id="actions" aria-labelledby="actions-heading">
      <div className="deed__intro container">
        <p className="deed__eyebrow">They do things</p>
        <h2 id="actions-heading">A text can move your day.</h2>
      </div>
      <div className="deed__wall" aria-label="Actions landing in Messages">
        {ACTIONS.map((a, i) => (
          <motion.article
            key={`${a.who}-${a.tool}`}
            className={`deed-card deed-card--${i % 3}`}
            initial={{ opacity: 0, y: 40, rotate: i % 2 === 0 ? -2 : 2 }}
            whileInView={{ opacity: 1, y: 0, rotate: i % 2 === 0 ? -1.5 : 1.5 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ delay: i * 0.08, duration: 0.5, type: 'spring', stiffness: 120 }}
          >
            <div className="deed-card__meta">
              <AlphaFace color={a.color} mood={i % 2 === 0 ? 'soft' : 'sharp'} size={36} />
              <div>
                <strong>{a.who}</strong>
                <span>{a.tool}</span>
              </div>
            </div>
            <p>{a.text}</p>
            <div className="deed-card__imsg" aria-hidden>iMessage</div>
          </motion.article>
        ))}
      </div>
    </section>
  )
}

function Voices() {
  const loop = [...VOICES, ...VOICES]
  return (
    <section className="voices" aria-label="Sample texts from each hire">
      <div className="voices__label">they’ll text you like this</div>
      <div className="voices__marquee">
        <div className="voices__track">
          {loop.map((v, i) => (
            <figure key={`${v.text}-${i}`} className="voice-card">
              <blockquote>{v.text}</blockquote>
              <figcaption>{v.who}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}

const HIRE_LINES: Record<AgentId, { label: string; phoneDisplay: string; soon?: boolean }> = {
  friend: { label: 'Friend', phoneDisplay: '(415) 595-1440' },
  coworker: { label: 'Coworker', phoneDisplay: '(628) 264-7648', soon: true },
  cofounder: { label: 'Cofounder', phoneDisplay: '(415) 603-5536', soon: true },
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  single: 'Single hire',
  bundle: 'All three',
  ultra: 'Ultra',
}

function WaitlistForm() {
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    } catch {
      return ''
    }
  })()
  const [hire, setHire] = useState<AgentId>('friend')
  const [done, setDone] = useState(false)
  const [assignedPhone, setAssignedPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [myCode, setMyCode] = useState('')
  const [waitlisted, setWaitlisted] = useState(false)
  const [plan, setPlan] = useState<{ tier: 'free' | 'single' | 'bundle' | 'ultra'; annual: boolean } | null>(null)

  useEffect(() => {
    const onPlan = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tier: 'free' | 'single'; annual: boolean }
      setPlan(detail)
    }
    window.addEventListener('hirealpha:plan', onPlan)
    return () => window.removeEventListener('hirealpha:plan', onPlan)
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const phoneValue = phone.trim()
    const emailValue = email.trim().toLowerCase()
    if (!phoneValue || !/^\S+@\S+\.\S+$/.test(emailValue)) {
      setError('Enter a valid email address and phone number.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: phoneValue,
          email: emailValue,
          hire,
          name: name.trim(),
          timezone: tz,
          ...(code.trim() ? { code: code.trim() } : {}),
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; waitlisted?: boolean; assignedPhone?: string }
      if (data.assignedPhone) setAssignedPhone(data.assignedPhone)
      if (!res.ok) {
        setError(data.error || 'Could not save your info. Try again.')
        setBusy(false)
        return
      }
      setWaitlisted(Boolean(data.waitlisted))
      setDone(true)
      track('waitlist_joined', { hire, via: code.trim() ? 'invite' : 'direct' })
      // Picked a paid plan on the pricing card: the signup just armed the
      // account, so carry them straight into Stripe instead of making them
      // find a button on the success screen.
      if (!data.waitlisted && plan && plan.tier !== 'free') {
        setBusy(false)
        void checkoutChosenPlan()
        return
      }
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  // Once they are in, mint their first invite code so the share button can
  // stitch it into the message — a referral that actually gets used.
  useEffect(() => {
    if (!done || !phone) return
    let live = true
    fetch(`/api/invites/for-phone?phone=${encodeURIComponent(phone.trim())}`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{ codes?: string[] }>)
          : Promise.reject(new Error(String(res.status))),
      )
      .then((data) => {
        if (live && Array.isArray(data.codes) && data.codes.length) setMyCode(data.codes[0])
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [done, phone])

  async function checkoutChosenPlan(fallback?: { tier: 'single'; annual: boolean }) {
    const use = plan && plan.tier !== 'free' ? plan : fallback
    if (!use) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          hire: 'friend',
          plan: use.annual ? `${use.tier}-annual` : use.tier,
          trial_days: 7,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string; free?: boolean }
      if (data.url) {
        window.location.href = data.url
        return
      }
      /* Free mode: the server answers with no checkout to open, so the signup
       * is done and the app is the destination. The paid path above is
       * untouched and takes over when HIREALPHA_PAYMENTS=1. */
      if (data.free) {
        window.location.href = '/app'
        return
      }
      setError(data.error || 'Checkout is not ready yet. Alpha will still text you.')
    } catch {
      setError('Could not reach checkout. Alpha will still text you.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    const line = HIRE_LINES[hire]
    return (
      <div className="waitlist-success" role="status">
        {waitlisted ? (
          <>
            You're on the waitlist. The first 100 spots are taken, and {line.label} texts the
            moment the next batch opens.
          </>
        ) : (
          <>
            You're in. {line.label} will reach out in about a minute. If nothing lands, text hi to{' '}
            {line.phoneDisplay} and the conversation starts there.
          </>
        )}
        {!waitlisted && plan && plan.tier !== 'free' && (
          <>
            <p className="waitlist-success__cta">
              Your plan: {PLAN_LABEL[plan.tier]}
              {plan.annual ? ' yearly' : ''}
            </p>
            <button
              type="button"
              className="btn btn--accent"
              disabled={busy}
              onClick={() => void checkoutChosenPlan()}
            >
              {busy ? 'Opening checkout…' : 'Continue to checkout'}
            </button>
          </>
        )}
        {!waitlisted && (!plan || plan.tier === 'free') && (
          <>
            <p className="waitlist-success__cta">7-day free trial, then $5/mo for 2 months</p>
            <button
              type="button"
              className="btn btn--accent"
              disabled={busy}
              onClick={() => void checkoutChosenPlan({ tier: 'single', annual: false })}
            >
              {busy ? 'Opening checkout…' : 'Start 7-day free trial'}
            </button>
          </>
        )}
        {!waitlisted && (
          <>
            <p className="waitlist-success__cta">Text Alpha now</p>
            <a className="btn btn--accent" href={`sms:${assignedPhone || '+14155951440'}&body=Hey%2C%20Alpha!`}>
              Open Messages
            </a>
          </>
        )}
        <a className="btn btn--accent" href={`sms:${assignedPhone || '+14155951440'}&body=Hey%2C%20Alpha!`}>
          Open Messages
        </a>
        <p style={{ margin: '10px 0 0' }}>
          <a className="btn btn--ghost" href={`/api/contact/alpha.vcf${assignedPhone ? `?phone=${encodeURIComponent(assignedPhone)}` : ''}`}>
            Save Alpha's contact
          </a>
        </p>
        <div className="qr">
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(`sms:${assignedPhone || "+14155951440"}`)}`}
            alt="QR code that opens a text to Alpha"
            loading="lazy"
            width={96}
            height={96}
          />
          <div className="qr__text">
            <strong>Scan to text Alpha</strong>
            <span>On a computer? Scan this with your phone.</span>
          </div>
        </div>
        <Invites phone={phone} />
        <div className="waitlist-share">
          <ShareButton code={myCode} />
        </div>
      </div>
    )
  }

  return (
    <>
      <input
        type="email"
        placeholder="you@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-label="Email for invites"
        disabled={busy}
        className="waitlist-form__email waitlist-form__email--top"
        required
        autoComplete="email"
      />
      <form className="waitlist-form" onSubmit={onSubmit}>
        <input
          type="text"
          placeholder="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Your full name"
          disabled={busy}
          autoComplete="name"
        />
        <input
          type="tel"
          placeholder="(555) 555-0100"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-label="Your phone number"
          disabled={busy}
          autoComplete="tel"
          required
        />
        <button type="submit" className="btn btn--accent" disabled={busy}>
          {busy ? 'Saving…' : 'Get my invite'}
        </button>
      </form>
      {tz && <p className="waitlist-tz">Briefs land in your timezone · {tz}</p>}
      <div className="waitlist-hire" role="radiogroup" aria-label="Who do you want to hire?">
        {(Object.keys(HIRE_LINES) as AgentId[]).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={hire === id}
            className={`waitlist-hire__chip${hire === id ? ' is-on' : ''}`}
            onClick={() => setHire(id)}
            disabled={busy}
          >
            {HIRE_LINES[id].label}
            {HIRE_LINES[id].soon && <em className="chip-soon">soon</em>}
          </button>
        ))}
      </div>
      {showCode ? (
        <input
          type="text"
          placeholder="Invite code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Invite code, if a friend shared one"
          disabled={busy}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="waitlist-form__email waitlist-form__email--top"
        />
      ) : (
        <button
          type="button"
          className="waitlist-code-link"
          onClick={() => setShowCode(true)}
          disabled={busy}
        >
          Have a code?
        </button>
      )}
      {error ? (
        <p className="waitlist-note" role="alert" style={{ color: 'var(--accent)' }}>
          {error}
        </p>
      ) : (
        <p className="waitlist-note">
          {HIRE_LINES[hire].soon
            ? `${HIRE_LINES[hire].label} is coming soon. Alpha the Friend is live today: your number and email hold your spot.`
            : `Number and email in, ${HIRE_LINES[hire].label} texts you first. iPhone Messages. Early access. $19 a month when you hire.`}
        </p>
      )}
    </>
  )
}

export default function Landing() {
  const [scrolled, setScrolled] = useState(false)
  /* Someone with an account should never be shown "Sign in" and "Get started"
   * as if they had neither. The landing is public, so the session is read after
   * mount rather than during render. */
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    setSignedIn(!!getSession()?.email)
  }, [])
  const [focus, setFocus] = useState<AgentId>('friend')
  const [demoPaused, setDemoPaused] = useState(false)
  const focused = AGENTS.find((a) => a.id === focus)!

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (demoPaused) return
    const order: AgentId[] = ['friend', 'coworker', 'cofounder']
    const id = window.setInterval(() => {
      setFocus((cur) => {
        const i = order.indexOf(cur)
        return order[(i + 1) % order.length]
      })
    }, 14000)
    return () => clearInterval(id)
  }, [demoPaused])

  return (
    <>
      <div className="page-bg" aria-hidden>
        <span className="orb orb--a" />
        <span className="orb orb--b" />
        <span className="orb orb--c" />
        <div className="page-bg__hills" />
      </div>

      <header>
        <nav className="nav" aria-label="Primary">
          <div className={`nav__pill${scrolled ? ' nav__pill--scrolled' : ''}`}>
            <a href="/" className="nav__brand" aria-label="HireAlpha home">
              <AlphaFace color="#ff5a1f" mood="soft" size={28} />
              HireAlpha
            </a>
            <div className="nav__links">
              <a href="#why">Why</a>
              <a href="#roles">Hires</a>
              <a href="#pricing">Pricing</a>
              <a href="#apps">Apps</a>
              <a href="#faq">FAQ</a>
              {/* Existing users need a way back in. The pricing CTAs only start
                  a new checkout, so without this the landing page had no route
                  to the dashboard for anyone already signed up — and once
                  signed in, "Sign in" and "Get started" are both wrong. */}
              {signedIn ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      signOut()
                      setSignedIn(false)
                    }}
                  >
                    Log out
                  </button>
                  <a href="/app" className="btn btn--primary btn--sm">
                    Dashboard
                  </a>
                </>
              ) : (
                <>
                  <a href="/app/login" className="btn btn--ghost btn--sm">
                    Sign in
                  </a>
                  <a href="#pricing" className="btn btn--primary btn--sm">
                    Get started
                  </a>
                </>
              )}
            </div>
          </div>
        </nav>
      </header>

      <main id="main" className="land">
        <section className="stage" aria-labelledby="hero-heading">
          <div className="stage__sky" aria-hidden>
            <motion.div
              className="stage-bubble stage-bubble--a"
              animate={{ y: [0, -14, 0], rotate: [-6, -3, -6] }}
              transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut' }}
            >
              <AlphaFace color="#2a6f7a" mood="soft" size={28} />
              <span>checked you in. flight lands 8:35 now</span>
            </motion.div>
            <motion.div
              className="stage-bubble stage-bubble--b"
              animate={{ y: [0, 12, 0], rotate: [5, 8, 5] }}
              transition={{ duration: 6.2, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }}
            >
              <span className="stage-bubble__tool">Gmail</span>
              <span>invoice says 4,000. the PO says 3,500. draft is ready</span>
            </motion.div>
            <motion.div
              className="stage-bubble stage-bubble--c"
              animate={{ y: [0, -10, 0], rotate: [4, 1, 4] }}
              transition={{ duration: 4.8, repeat: Infinity, ease: 'easeInOut', delay: 0.8 }}
            >
              <AlphaFace color="#8b4513" mood="bold" size={28} />
              <span>two investor replies overnight. the deck is drafted</span>
            </motion.div>
            <motion.div
              className="stage-bubble stage-bubble--d"
              animate={{ y: [0, 8, 0], rotate: [-4, -7, -4] }}
              transition={{ duration: 5.8, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
            >
              <span className="stage-bubble__tool">Maps</span>
              <span>leave by 5:20 and you make the 6:30</span>
            </motion.div>
          </div>

          <div className="stage__brand">
            <p className="stage__wordmark">HireAlpha</p>
            <h1 id="hero-heading" className="stage__line">
              people in your texts you can actually <em>hire</em>
            </h1>
          </div>

          <div className="stage__cast" id="demo">
            <motion.div
              key={focused.id}
              className="stage__nametag"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
            >
              <AlphaFace color={focused.color} mood={focused.mood} size={44} />
              <div>
                <span>hello, my name is</span>
                <strong>{focused.imsgName}</strong>
              </div>
            </motion.div>

            <div className="stage__tabs" role="tablist" aria-label="Preview a hire">
              {AGENTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={focus === a.id}
                  className={`stage-tab${focus === a.id ? ' stage-tab--on' : ''}`}
                  style={{ '--tab': a.color } as CSSProperties}
                  onClick={() => {
                    setDemoPaused(true)
                    setFocus(a.id)
                  }}
                >
                  <AlphaFace color={a.color} mood={a.mood} size={28} />
                  <strong>{a.name}</strong>
                  {a.soon && <em className="chip-soon">soon</em>}
                </button>
              ))}
            </div>

            <div className="stage__dock">
              <a href={signedIn ? '/app' : '#pricing'} className="btn btn--primary btn--lg">
                {signedIn ? 'Open the dashboard' : 'Get started'}
              </a>
              <p>Not an app. People in your Messages who text first and remember everything.</p>
            </div>
          </div>

          <div className="stage__device">
            <PhoneDemo
              focus={focus}
              onFocusChange={setFocus}
              onInteract={() => setDemoPaused(true)}
            />
          </div>
        </section>

        <section className="manifesto manifesto--bleed" id="why" aria-labelledby="why-heading">
          <p className="manifesto__lead">We all have AI.</p>
          <h2 id="why-heading">Almost nobody has it in Messages.</h2>
          <p className="manifesto__body">
            Every AI waits for you to ask. Alpha texts first. It checks you in before the window closes, catches the invoice that looks wrong, and has the reply drafted before you have seen it. It asks before it sends or spends. Three hires, separate threads, in the app you already open.
          </p>
        </section>

        <Voices />

        <section className="cast section" id="roles" aria-labelledby="roles-heading">
          <div className="container cast__head">
            <h2 id="roles-heading">Meet the three.</h2>
            <p>One product. Three people. Pick a relationship.</p>
          </div>

          <div className="cast__stage">
            <motion.div
              key={focused.id}
              className="cast__hero"
              style={{ background: focused.color }}
              initial={{ opacity: 0.6, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.35 }}
            >
              <div className="cast__face-plate">
                <AlphaFace color={focused.color} mood={focused.mood} size={120} />
              </div>
              <div className="cast__hero-copy">
                <p className="cast__eyebrow">in Messages as</p>
                <h3>{focused.imsgName}</h3>
                <p className="cast__role">{focused.role}</p>
                <p>{focused.pitch}</p>
                <button
                  type="button"
                  className="btn btn--ghost cast__preview"
                  onClick={() =>
                    document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                >
                  Watch {focused.name} text
                </button>
              </div>
            </motion.div>

            <div className="cast__rail" role="list">
              {AGENTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="listitem"
                  className={`cast__pick${focus === a.id ? ' cast__pick--on' : ''}`}
                  onClick={() => {
                    setDemoPaused(true)
                    setFocus(a.id)
                  }}
                >
                  <AlphaFace color={a.color} mood={a.mood} size={48} />
                  <span>
                    <strong>{a.name}</strong>
                    <small>{a.role}{a.soon ? ' · soon' : ''}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <Apps
          hire={focus}
          onPick={(id) => {
            setDemoPaused(true)
            setFocus(id)
          }}
        />

        <Actions />

        <GreatestHits />

        <Pricing />

        <section className="path section" id="how" aria-labelledby="how-heading">
          <div className="container">
            <h2 id="how-heading" className="path__title">Invite. Save a number. Keep texting.</h2>
            <ol className="path__steps">
              <li>
                <strong>01</strong>
                <span>Join early access</span>
              </li>
              <li>
                <strong>02</strong>
                <span>Get their number in Messages</span>
              </li>
              <li>
                <strong>03</strong>
                <span>They remember, text, and act</span>
              </li>
            </ol>
          </div>
        </section>

        <section className="section" id="faq" aria-labelledby="faq-heading">
          <div className="container">
            <div className="faq">
              <div className="faq__head">
                <h2 id="faq-heading">Before you join.</h2>
                <p>The practical stuff.</p>
              </div>
              <div className="faq__list">
                {FAQS.map((item) => (
                  <details key={item.question} className="faq__item">
                    <summary>{item.question}</summary>
                    <p>{item.answer}</p>
                  </details>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="finale" id="waitlist" aria-labelledby="waitlist-heading">
          <div className="finale__glow" aria-hidden />
          <AlphaFace color="#2a6f7a" mood="soft" size={96} />
          <h2 id="waitlist-heading">Get a number in Messages.</h2>
          <p>Be first when invites go out.</p>
          <div className="finale__form">
            <WaitlistForm />
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="container footer__inner">
          <div className="footer__brand">
            <AlphaFace color="#ff5a1f" mood="soft" size={24} />
            <p>
              <strong>HireAlpha</strong>
            </p>
          </div>
          <nav className="footer__nav" aria-label="Footer">
            <a href="#why">Why</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
            <a href="#waitlist">Start free</a>
            <a href="/app/controls">Controls</a>
          </nav>
          <nav className="footer__nav footer__nav--meta" aria-label="Trust and company">
            <a href="/about">About</a>
            <a href="/faq">FAQs</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/contact">Contact</a>
            <a href="/developers">Developers</a>
          </nav>
          <p className="footer__copy">© {new Date().getFullYear()} HireAlpha</p>
        </div>
      </footer>
    </>
  )
}
