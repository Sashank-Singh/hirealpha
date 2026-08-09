import { motion, AnimatePresence } from 'framer-motion'
import {
  siGmail,
  siGooglecalendar,
  siSlack,
  siNotion,
  siLinear,
  siGithub,
  siGoogledrive,
  siSpotify,
  siUber,
  siStripe,
  siFigma,
  siGooglemaps,
} from 'simple-icons'
import { useState, useEffect, useCallback, type FormEvent } from 'react'
import { SeoHead } from '../seo/SeoHead'
import { buildHomeJsonLd } from '../seo/jsonLd'
import '../index.css'

type AgentId = 'friend' | 'coworker' | 'cofounder'

interface Msg {
  text: string
  from: 'me' | 'them'
}

interface Agent {
  id: AgentId
  name: string
  imsgName: string
  role: string
  initial: string
  color: string
  pitch: string
  preview: string
  time: string
  unread: boolean
  messages: Msg[]
}

const AGENTS: Agent[] = [
  {
    id: 'friend',
    name: 'Friend',
    imsgName: 'Alpha',
    role: 'Personal companion',
    initial: 'A',
    color: '#2a6f7a',
    pitch:
      'Plans, venting, advice, and check ins. Remembers your story and texts like someone who actually knows you.',
    preview: 'You mentioned the interview. how are you feeling?',
    time: '2m',
    unread: true,
    messages: [
      { text: "I'm spiraling about tomorrow", from: 'me' },
      { text: 'Content, crowd, or how you’ll come across?', from: 'them' },
      { text: 'How I come across. I freeze every time.', from: 'me' },
      {
        text: 'Pick one anchor slide. When you blank, go back to it. That’s nerves, not skill.',
        from: 'them',
      },
    ],
  },
  {
    id: 'coworker',
    name: 'Coworker',
    imsgName: 'Alpha (Coworker)',
    role: 'Work colleague',
    initial: 'A',
    color: '#3b5bdb',
    pitch:
      'Standups, meeting prep, and follow ups. The teammate who already knows the project.',
    preview: 'Standup bullets ready. Want the migration note?',
    time: '11m',
    unread: true,
    messages: [
      { text: 'Standup in 5. Help?', from: 'me' },
      {
        text: 'Yesterday: auth done. Today: staging fix. Blocked on modal specs.',
        from: 'them',
      },
      { text: 'Add the migration note?', from: 'me' },
      { text: 'Done. You’re clear to paste.', from: 'them' },
    ],
  },
  {
    id: 'cofounder',
    name: 'Cofounder',
    imsgName: 'Alpha(CoFounder)',
    role: 'Startup partner',
    initial: 'A',
    color: '#8b4513',
    pitch:
      'Strategy, hiring opinions, fundraising pushback. Tells you what you need to hear.',
    preview: 'Before that VP, are you closing yourself yet?',
    time: '1h',
    unread: false,
    messages: [
      { text: 'Hire head of sales before A?', from: 'me' },
      { text: 'What’s stalling, leads or conversion?', from: 'them' },
      { text: 'Conversion. Deals drag forever.', from: 'me' },
      {
        text: 'Hire a senior AE first. VP sales before PMF burns cash and six months.',
        from: 'them',
      },
    ],
  },
]

const OTHER_THREADS = [
  { name: 'Mom', preview: 'Call me when you’re free', time: 'Sun', color: '#c45c26', initial: 'M' },
  { name: 'Alex', preview: 'Sounds good 👍', time: 'Sat', color: '#5c6bc0', initial: 'A' },
]

type BrandIcon = { title: string; slug: string; hex: string; path: string }

const CONNECTORS: { name: string; icon: BrandIcon }[] = [
  { name: 'Gmail', icon: siGmail },
  { name: 'Calendar', icon: siGooglecalendar },
  { name: 'Slack', icon: siSlack },
  { name: 'Notion', icon: siNotion },
  { name: 'Linear', icon: siLinear },
  { name: 'GitHub', icon: siGithub },
  { name: 'Drive', icon: siGoogledrive },
  { name: 'Spotify', icon: siSpotify },
  { name: 'Uber', icon: siUber },
  { name: 'Stripe', icon: siStripe },
  { name: 'Figma', icon: siFigma },
  { name: 'Maps', icon: siGooglemaps },
]

const FAQS: { question: string; answer: string }[] = [
  {
    question: 'What is HireAlpha?',
    answer:
      'HireAlpha lets you hire AI agents that live in iMessage. Friend, Coworker, and Cofounder each get their own phone number and personality — not modes of a single chatbot.',
  },
  {
    question: 'How is HireAlpha different from ChatGPT or other AI assistants?',
    answer:
      'Most assistants live in an app with one persona. HireAlpha gives you separate contacts in Messages: a personal companion, a work colleague, and a startup partner. You text them like people.',
  },
  {
    question: 'Does HireAlpha work inside iMessage?',
    answer:
      'Yes. After you hire an agent, you get a number that appears in Apple Messages. There is no separate chat app to open for day-to-day use.',
  },
  {
    question: 'How much does HireAlpha cost?',
    answer:
      'Each hire is $19 per month and includes its own number. You can hire Friend, Coworker, Cofounder, or any combination.',
  },
  {
    question: 'Can I connect Gmail, Calendar, Slack, and other apps?',
    answer:
      'Yes. Connectors let your hires read context and take action from tools you already use, including Gmail, Calendar, Slack, Notion, Linear, GitHub, and more.',
  },
  {
    question: 'Is HireAlpha available now?',
    answer:
      'HireAlpha is on a waitlist. Join with your email and we will invite you when Friend, Coworker, and Cofounder numbers open.',
  },
]

function Connectors() {
  return (
    <section className="section" id="connectors" aria-labelledby="connectors-heading">
      <div className="container">
        <div className="connectors">
          <div className="connectors__copy">
            <p className="connectors__eyebrow">Connectors</p>
            <h2 id="connectors-heading">Plug Alpha into the apps you already use.</h2>
            <p>
              Your hires do not live in a vacuum. Connect Gmail, Calendar, Slack, Notion, and more so they can read context and take action from a text.
            </p>
            <ul className="connectors__list">
              <li>Connect once, use across Friend, Coworker, and Cofounder</li>
              <li>Ask in Messages, get answers grounded in your tools</li>
              <li>More connectors shipping with waitlist access</li>
            </ul>
          </div>

          <div className="connectors__stage" aria-label="Connected apps">
            <div className="connectors__orbit" aria-hidden />
            <div className="connectors__core">
              <span className="connectors__core-mark">α</span>
              <strong>Alpha</strong>
              <small>connects to</small>
            </div>
            <div className="connectors__grid">
              {CONNECTORS.map((c, i) => (
                <motion.div
                  key={c.icon.slug}
                  className="connector-logo"
                  initial={{ opacity: 0, y: 10, scale: 0.92 }}
                  whileInView={{ opacity: 1, y: 0, scale: 1 }}
                  viewport={{ once: true, margin: '-40px' }}
                  transition={{ delay: i * 0.04, duration: 0.35 }}
                  whileHover={{ y: -3, scale: 1.08, transition: { duration: 0.15 } }}
                >
                  <svg
                    className="connector-logo__img"
                    role="img"
                    viewBox="0 0 24 24"
                    aria-label={c.name}
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path fill={`#${c.icon.hex}`} d={c.icon.path} />
                  </svg>
                  <span>{c.name}</span>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function StatusBar() {
  return (
    <div className="ios-status">
      <span className="ios-status__time">9:41</span>
      <div className="ios-status__icons" aria-hidden>
        <svg className="ios-icon" viewBox="0 0 18 12" width="18" height="12">
          <rect x="0" y="8" width="3" height="4" rx="0.6" fill="currentColor" />
          <rect x="4.5" y="5.5" width="3" height="6.5" rx="0.6" fill="currentColor" />
          <rect x="9" y="3" width="3" height="9" rx="0.6" fill="currentColor" />
          <rect x="13.5" y="0.5" width="3" height="11.5" rx="0.6" fill="currentColor" />
        </svg>
        <svg className="ios-icon" viewBox="0 0 16 12" width="16" height="12">
          <path
            fill="currentColor"
            d="M8 3.2c1.9 0 3.6.7 5 2l1.1-1.2C12.4 2.3 10.3 1.3 8 1.3S3.6 2.3 1.9 4L3 5.2c1.4-1.3 3.1-2 5-2zm0 2.5c1.2 0 2.3.4 3.2 1.2L12.4 5C11.2 3.9 9.7 3.2 8 3.2S4.8 3.9 3.6 5l1.2 1.9c.9-.8 2-1.2 3.2-1.2zM8 8.2c.7 0 1.3.2 1.8.7L8 11 6.2 8.9c.5-.5 1.1-.7 1.8-.7z"
          />
        </svg>
        <span className="ios-battery">
          <span className="ios-battery__body">
            <span className="ios-battery__level" />
          </span>
          <span className="ios-battery__cap" />
        </span>
      </div>
    </div>
  )
}

function TypingDots() {
  return (
    <div className="bubble bubble--them bubble--typing" aria-hidden>
      <div className="typing">
        <span /><span /><span />
      </div>
    </div>
  )
}

function PhoneDemo({ focus }: { focus: AgentId }) {
  const [phase, setPhase] = useState<'inbox' | 'opening' | 'thread'>('inbox')
  const [visible, setVisible] = useState(0)
  const [typing, setTyping] = useState(false)
  const agent = AGENTS.find((a) => a.id === focus)!

  useEffect(() => {
    setPhase('inbox')
    setVisible(0)
    setTyping(false)

    const openTimer = window.setTimeout(() => setPhase('opening'), 2400)
    const threadTimer = window.setTimeout(() => setPhase('thread'), 3100)
    return () => {
      clearTimeout(openTimer)
      clearTimeout(threadTimer)
    }
  }, [focus])

  const advance = useCallback(() => {
    const msgs = agent.messages
    if (visible >= msgs.length) {
      const t = window.setTimeout(() => {
        setPhase('inbox')
        setVisible(0)
        setTyping(false)
        window.setTimeout(() => setPhase('opening'), 2400)
        window.setTimeout(() => setPhase('thread'), 3100)
      }, 2800)
      return () => clearTimeout(t)
    }

    const next = msgs[visible]
    if (next.from === 'them') {
      setTyping(true)
      const t = window.setTimeout(() => {
        setTyping(false)
        setVisible((v) => v + 1)
      }, 1100)
      return () => clearTimeout(t)
    }
    const t = window.setTimeout(() => setVisible((v) => v + 1), 750)
    return () => clearTimeout(t)
  }, [agent.messages, visible])

  useEffect(() => {
    if (phase !== 'thread') return
    return advance()
  }, [phase, visible, advance])

  const rows = [
    ...AGENTS.map((a) => ({
      key: a.id,
      name: a.imsgName,
      preview: a.preview,
      time: a.time,
      color: a.color,
      initial: a.initial,
      unread: a.unread || a.id === focus,
      active: a.id === focus,
    })),
    ...OTHER_THREADS.map((t, i) => ({
      key: `other-${i}`,
      ...t,
      unread: false,
      active: false,
    })),
  ]

  const shown = agent.messages.slice(0, visible)
  const lastIsMe = shown.length > 0 && shown[shown.length - 1].from === 'me' && !typing

  return (
    <div className="phone" aria-label="iPhone Messages demo">
      <div className="phone__btn phone__btn--silent" aria-hidden />
      <div className="phone__btn phone__btn--vol-up" aria-hidden />
      <div className="phone__btn phone__btn--vol-down" aria-hidden />
      <div className="phone__btn phone__btn--power" aria-hidden />

      <div className="phone__bezel">
        <div className="phone__screen">
          <div className="phone__island" aria-hidden />
          <StatusBar />

          <AnimatePresence mode="wait">
            {(phase === 'inbox' || phase === 'opening') && (
              <motion.div
                key="inbox"
                className="imsg-view"
                initial={{ opacity: 0, x: -18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -36 }}
                transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
              >
                <div className="inbox-top">
                  <div className="inbox-top__row">
                    <button type="button" className="inbox-link">Edit</button>
                    <button type="button" className="inbox-compose" aria-label="Compose">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                        <path d="M4 18.5V20h1.5L16.2 9.3l-1.5-1.5L4 18.5z" fill="currentColor" />
                        <path d="M17.7 6.3c.4-.4.4-1 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0l-1.2 1.2 3 3 1.2-1.2z" fill="currentColor" />
                      </svg>
                    </button>
                  </div>
                  <h2 className="inbox-title">Messages</h2>
                  <div className="inbox-search">
                    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden>
                      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
                      <path d="M12.5 12.5L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                    <span>Search</span>
                  </div>
                  <div className="inbox-filters">
                    <span className="inbox-filters__active">All</span>
                    <span>Known Senders</span>
                    <span>Unread</span>
                  </div>
                </div>

                <div className="inbox-list">
                  {rows.map((row, i) => (
                    <motion.div
                      key={row.key}
                      className={`inbox-row${row.active && phase === 'opening' ? ' inbox-row--active' : ''}${row.unread ? ' inbox-row--unread' : ''}`}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 * i, duration: 0.3 }}
                    >
                      <div className="inbox-unread-dot" />
                      <div className="inbox-avatar" style={{ background: row.color }}>
                        {row.initial}
                      </div>
                      <div className="inbox-meta">
                        <div className="inbox-meta__top">
                          <span className="inbox-meta__name">{row.name}</span>
                          <span className="inbox-meta__time">
                            {row.time}
                            <svg viewBox="0 0 8 14" width="7" height="11" aria-hidden>
                              <path d="M1 1l5 6-5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                        </div>
                        <p className="inbox-meta__preview">{row.preview}</p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}

            {phase === 'thread' && (
              <motion.div
                key="thread"
                className="imsg-view imsg-view--thread"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 40 }}
                transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
              >
                <div className="thread-bar">
                  <button type="button" className="thread-back" aria-label="Back">
                    <svg viewBox="0 0 12 20" width="11" height="18">
                      <path d="M10 2L2 10l8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>68</span>
                  </button>
                  <div className="thread-who">
                    <div className="thread-avatar" style={{ background: agent.color }}>
                      {agent.initial}
                    </div>
                    <div className="thread-who__text">
                      <strong>
                        {agent.imsgName}
                        <svg viewBox="0 0 8 14" width="6" height="9" aria-hidden>
                          <path d="M1 1l5 6-5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </strong>
                    </div>
                  </div>
                  <button type="button" className="thread-facetime" aria-label="FaceTime">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h7A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 16.5v-9zm13.2 2.1 3.3-2.2a.8.8 0 0 1 1.3.7v7.8a.8.8 0 0 1-1.3.7l-3.3-2.2v-4.8z" />
                    </svg>
                  </button>
                </div>

                <div className="thread-body">
                  <p className="thread-stamp">Today 9:41 AM</p>
                  <AnimatePresence initial={false}>
                    {shown.map((m, i) => (
                      <motion.div
                        key={`${agent.id}-${i}`}
                        className={`bubble bubble--${m.from}`}
                        initial={{ opacity: 0, y: 12, scale: 0.94 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ type: 'spring', stiffness: 420, damping: 30 }}
                      >
                        {m.text}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                  {typing && <TypingDots />}
                  {lastIsMe && <p className="thread-delivered">Delivered</p>}
                </div>

                <div className="thread-composer">
                  <button type="button" className="composer-plus" aria-label="Apps">
                    <svg viewBox="0 0 24 24" width="22" height="22">
                      <circle cx="12" cy="12" r="10" fill="#8e8e93" />
                      <path d="M12 7v10M7 12h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                  <div className="composer-field">
                    <span>iMessage</span>
                    <button type="button" className="composer-mic" aria-label="Audio">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="#8e8e93">
                        <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="phone__home" aria-hidden />
              </motion.div>
            )}
          </AnimatePresence>

          {(phase === 'inbox' || phase === 'opening') && (
            <div className="phone__home phone__home--inbox" aria-hidden />
          )}
        </div>
      </div>
    </div>
  )
}

function WaitlistForm() {
  const [email, setEmail] = useState('')
  const [done, setDone] = useState(false)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !email.includes('@')) return
    const list = JSON.parse(localStorage.getItem('hirealpha-waitlist') || '[]') as string[]
    if (!list.includes(email.trim())) {
      list.push(email.trim())
      localStorage.setItem('hirealpha-waitlist', JSON.stringify(list))
    }
    setDone(true)
  }

  if (done) {
    return (
      <div className="waitlist-success" role="status">
        You’re on the list. We’ll email {email} when Friend, Coworker, and Cofounder are ready to hire.
      </div>
    )
  }

  return (
    <>
      <form className="waitlist-form" onSubmit={onSubmit}>
        <input
          type="email"
          required
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email for waitlist"
        />
        <button type="submit" className="btn btn--accent">
          Join waitlist
        </button>
      </form>
      <p className="waitlist-note">Early access only. We’ll text you a number when it’s live.</p>
    </>
  )
}

export default function Landing() {
  const [scrolled, setScrolled] = useState(false)
  const [focus, setFocus] = useState<AgentId>('friend')

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const order: AgentId[] = ['friend', 'coworker', 'cofounder']
    const id = window.setInterval(() => {
      setFocus((cur) => {
        const i = order.indexOf(cur)
        return order[(i + 1) % order.length]
      })
    }, 14000)
    return () => clearInterval(id)
  }, [])

  return (
    <>
      <SeoHead path="/" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(buildHomeJsonLd(FAQS)) }}
      />

      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <div className="page-bg" aria-hidden>
        <div className="page-bg__sun" />
        <div className="page-bg__hills" />
      </div>

      <header>
        <nav className="nav" aria-label="Primary">
          <div className={`nav__pill${scrolled ? ' nav__pill--scrolled' : ''}`}>
            <a href="/" className="nav__brand" aria-label="HireAlpha home">
              <span className="nav__mark" aria-hidden>
                α
              </span>
              HireAlpha
            </a>
            <div className="nav__links">
              <a href="#roles">The three</a>
              <a href="#connectors">Connectors</a>
              <a href="#how">How it works</a>
              <a href="#faq">FAQ</a>
              <a href="/login" className="btn btn--ghost btn--sm">
                Log in
              </a>
              <a href="#waitlist" className="btn btn--primary btn--sm">
                Join waitlist
              </a>
            </div>
          </div>
        </nav>
      </header>

      <main id="main">
        <section className="container hero" aria-labelledby="hero-heading">
          <div>
            <p className="hero__eyebrow">HireAlpha · Three hires in iMessage</p>
            <h1 id="hero-heading">
              people in your texts you can actually <em>hire</em>
            </h1>
            <p className="hero__sub">
              HireAlpha is the way to hire Friend, Coworker, and Cofounder as AI agents in Apple Messages.
              Three characters, three numbers, $19/mo each. Not one assistant with modes. Real hires in iMessage.
            </p>
            <div className="hero__cta">
              <a href="/login" className="btn btn--primary">
                Log in to hire
              </a>
              <a href="#roles" className="btn btn--ghost">
                Meet the three
              </a>
            </div>
            <div className="hero__proof">
              <span>Lives in Messages</span>
              <span>Hire one or all</span>
              <span>$19/mo each</span>
            </div>
          </div>

          <div className="phone-stage">
            <div className="phone-stage__halo" aria-hidden />
            <motion.div
              className="float-chip float-chip--a"
              animate={{ y: [0, -8, 0] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
            >
              Hire Friend
              <small>personal companion</small>
            </motion.div>
            <motion.div
              className="float-chip float-chip--b"
              animate={{ y: [0, 10, 0] }}
              transition={{ duration: 3.8, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }}
            >
              Hire Coworker
              <small>work colleague</small>
            </motion.div>
            <motion.div
              className="float-chip float-chip--c"
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut', delay: 0.8 }}
            >
              Hire Cofounder
              <small>startup partner</small>
            </motion.div>
            <PhoneDemo focus={focus} />
          </div>
        </section>

        <section className="section" id="roles" aria-labelledby="roles-heading">
          <div className="container">
            <div className="roles-head">
              <h2 id="roles-heading">Not one assistant. Three hires.</h2>
              <p>
                Pick the relationship you need. Each HireAlpha agent is a different person with a different number,
                not modes of the same chatbot.
              </p>
            </div>
            <div className="roles-grid">
              {AGENTS.map((a) => (
                <article key={a.id} className="role-card">
                  <div className="role-card__swatch" style={{ background: a.color }}>
                    {a.initial}
                  </div>
                  <h3>{a.name}</h3>
                  <p className={`role-card__imsg role-card__imsg--${a.id}`}>
                    <span className="role-card__imsg-label">in Messages as</span>
                    <span className="role-card__imsg-name">{a.imsgName}</span>
                  </p>
                  <p className="role-card__role">{a.role}</p>
                  <p>{a.pitch}</p>
                  <p className="role-card__price">$19 / month</p>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => {
                      setFocus(a.id)
                      window.scrollTo({ top: 0, behavior: 'smooth' })
                    }}
                  >
                    Preview in Messages
                  </button>
                </article>
              ))}
            </div>
          </div>
        </section>

        <Connectors />

        <section className="section" id="how" aria-labelledby="how-heading">
          <div className="container">
            <div className="how">
              <h2 id="how-heading">Save a number. Start texting. That’s it.</h2>
              <div className="how-steps">
                <div className="how-step">
                  <div className="how-step__n">01</div>
                  <h3>Choose who to hire</h3>
                  <p>Friend, Coworker, or Cofounder. One role, one personality, one line.</p>
                </div>
                <div className="how-step">
                  <div className="how-step__n">02</div>
                  <h3>Get their number</h3>
                  <p>Shows up in Messages like anyone else. No app to open.</p>
                </div>
                <div className="how-step">
                  <div className="how-step__n">03</div>
                  <h3>Text like you mean it</h3>
                  <p>They reply in thread, remember context, and stay in character.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="faq" aria-labelledby="faq-heading">
          <div className="container">
            <div className="faq">
              <div className="faq__head">
                <h2 id="faq-heading">Questions, answered.</h2>
                <p>Everything you need to know about hiring AI agents in iMessage with HireAlpha.</p>
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

        <section className="section" id="waitlist" aria-labelledby="waitlist-heading">
          <div className="container">
            <div className="waitlist">
              <h2 id="waitlist-heading">Ready when we are.</h2>
              <p>
                We’re not live yet, so there’s nothing to log in to. Leave your email and we’ll invite you when the three numbers open.
              </p>
              <WaitlistForm />
              <div className="price-chips">
                {AGENTS.map((a) => (
                  <div key={a.id} className="price-chip">
                    <strong>{a.name}</strong>
                    <span>$19/mo, own number</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="container footer__inner">
          <div className="footer__brand">
            <p>
              <strong>HireAlpha</strong>. Hire Friend, Coworker, or Cofounder in your texts.
            </p>
            <p className="footer__tag">AI agents that live in iMessage — separate numbers, $19/mo each.</p>
          </div>
          <nav className="footer__nav" aria-label="Footer">
            <a href="#roles">The three</a>
            <a href="#connectors">Connectors</a>
            <a href="#how">How it works</a>
            <a href="#faq">FAQ</a>
            <a href="#waitlist">Waitlist</a>
            <a href="/login">Log in</a>
          </nav>
          <p className="footer__copy">© {new Date().getFullYear()} HireAlpha. All rights reserved.</p>
        </div>
      </footer>
    </>
  )
}
