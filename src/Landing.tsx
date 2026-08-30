import { motion, AnimatePresence } from 'framer-motion'
import { useState, useEffect, useCallback, useRef, type FormEvent, type CSSProperties } from 'react'
import { AlphaFace } from './AlphaFace'
import { Invites } from './marketing/Invites'
import { Pricing } from './marketing/Pricing'
import { ShareButton } from './marketing/ShareButton'
import { track } from './track'
import { GreatestHits } from './marketing/GreatestHits'
import './landing-stage.css'

type AgentId = 'friend' | 'coworker' | 'cofounder'

interface Msg {
  text: string
  from: 'me' | 'them'
  kind?: 'text' | 'action'
  app?: string
  title?: string
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
  mood: 'soft' | 'sharp' | 'bold'
  soon?: boolean
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
    mood: 'soft',
    pitch:
      'The friend who already knows your people. Texts first. Lives next to Mom in Messages.',
    preview: 'checked you in for AA248. heads up, it now lands 6:15. want dinner moved to 8:45?',
    time: '2m',
    unread: true,
    messages: [
      { text: 'checked you in. seat 14C, gate B14', from: 'them' },
      {
        text: 'AA248 boarding pass. Tap to open.',
        from: 'them',
        kind: 'action',
        app: 'Wallet',
        title: 'AA248 · SFO 6:15 → JFK',
      },
      { text: 'flight delayed, lands 6:15. want dinner with Michael pushed to 8:45?', from: 'them' },
      { text: 'yes move it', from: 'me' },
      { text: 'done. 8:45, same place', from: 'them' },
    ],
  },
  {
    id: 'coworker',
    name: 'Coworker',
    imsgName: 'Alpha (Coworker)',
    role: 'Work colleague',
    initial: 'A',
    color: '#3b5bdb',
    mood: 'sharp',
    pitch:
      'caught an invoice that disagreed with the PO. the reply was drafted before you saw it.',
    preview: 'priya’s invoice says 4,000. the PO says 3,500. draft is ready',
    time: '4m',
    unread: true,
    messages: [
      { text: 'priya’s invoice says 4,000. the PO says 3,500', from: 'them' },
      { text: 'which one is right', from: 'me' },
      { text: 'the PO. reply is drafted, pointing at line 3 with the receipt attached', from: 'them' },
      {
        text: 'Draft to Priya. Waiting on you.',
        from: 'them',
        kind: 'action',
        app: 'Approve & send',
        title: 'Approve and it sends',
      },
      { text: 'it sends when you tap. not before', from: 'them' },
    ],
  },
  {
    id: 'cofounder',
    name: 'Cofounder',
    imsgName: 'Alpha(CoFounder)',
    role: 'Startup partner',
    initial: 'A',
    color: '#8b4513',
    mood: 'bold',
    pitch:
      'two investor replies came in overnight. the deck was drafted before you woke up.',
    preview: 'two investor replies overnight. draft is ready. runway says 9 months',
    time: '22m',
    unread: true,
    messages: [
      { text: 'overnight: two investor replies. both want the deck thursday', from: 'them' },
      { text: 'of course they do', from: 'me' },
      { text: 'deck is drafted from the pipeline numbers. it is in investor note, waiting on you', from: 'them' },
      { text: 'and the 18k site redesign', from: 'me' },
      { text: 'runway says 9 months. the site is a costume. the 14 people who came back are the company', from: 'them' },
    ],
  },
]

const OTHER_THREADS: {
  id: 'mom' | 'alex'
  name: string
  preview: string
  time: string
  color: string
  initial: string
  messages: Msg[]
}[] = [
  {
    id: 'mom',
    name: 'Mom',
    preview: 'Call me when you’re free',
    time: 'Sun',
    color: '#c45c26',
    initial: 'M',
    messages: [
      { text: 'Did you eat today?', from: 'them' },
      { text: 'Yes mom. Leftovers.', from: 'me' },
      { text: 'Call me when you’re free', from: 'them' },
      { text: 'Will call after this meeting', from: 'me' },
    ],
  },
  {
    id: 'alex',
    name: 'Alex',
    preview: 'Sounds good 👍',
    time: 'Sat',
    color: '#5c6bc0',
    initial: 'A',
    messages: [
      { text: 'Coffee Saturday?', from: 'me' },
      { text: 'Yes. Eleven at the usual place?', from: 'them' },
      { text: 'Perfect', from: 'me' },
      { text: 'Sounds good 👍', from: 'them' },
    ],
  },
]

type ThreadId = AgentId | 'mom' | 'alex'

function isAgentId(id: ThreadId): id is AgentId {
  return id === 'friend' || id === 'coworker' || id === 'cofounder'
}

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
      'Yes. Start with whichever relationship you need. Add others later. Each is billed separately.',
  },
  {
    question: 'When do connectors unlock?',
    answer:
      'In early access. Gmail, Calendar, Maps, Spotify, Slack, and the rest connect from Settings so the hire can use them in texts.',
  },
  {
    question: 'What do you do with my texts?',
    answer:
      'We do not sell your conversations. Threads stay with your hires, and you’ll control what each one can see once you connect its tools.',
  },
  {
    question: 'What happens after I join the waitlist?',
    answer:
      'You get an invite email when spots open, then a number to save in Messages. No charge until you actually hire.',
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

function StatusBar() {
  return (
    <div className="ios-status">
      <span className="ios-status__time">9:41</span>
      <span className="ios-status__island" aria-hidden />
      <div className="ios-status__icons" aria-hidden>
        <svg className="ios-icon" viewBox="0 0 18 12" width="17" height="11">
          <rect x="0" y="8" width="3" height="4" rx="0.6" fill="currentColor" />
          <rect x="4.5" y="5.5" width="3" height="6.5" rx="0.6" fill="currentColor" />
          <rect x="9" y="3" width="3" height="9" rx="0.6" fill="currentColor" />
          <rect x="13.5" y="0.5" width="3" height="11.5" rx="0.6" fill="currentColor" />
        </svg>
        <svg className="ios-icon" viewBox="0 0 16 12" width="15" height="11">
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

function PhoneDemo({
  focus,
  onFocusChange,
  onInteract,
}: {
  focus: AgentId
  onFocusChange?: (id: AgentId) => void
  onInteract?: () => void
}) {
  const [phase, setPhase] = useState<'inbox' | 'thread'>('inbox')
  const [threadId, setThreadId] = useState<ThreadId>(focus)
  const [visible, setVisible] = useState(0)
  const [typing, setTyping] = useState(false)
  const skipFocusSync = useRef(false)
  const navGen = useRef(0)

  const agentThread = AGENTS.find((a) => a.id === threadId)
  const otherThread = OTHER_THREADS.find((t) => t.id === threadId)
  const active = agentThread
    ? {
        id: agentThread.id as ThreadId,
        name: agentThread.imsgName,
        color: agentThread.color,
        mood: agentThread.mood,
        face: true as const,
        initial: agentThread.initial,
        messages: agentThread.messages,
      }
    : {
        id: otherThread!.id as ThreadId,
        name: otherThread!.name,
        color: otherThread!.color,
        mood: 'soft' as const,
        face: false as const,
        initial: otherThread!.initial,
        messages: otherThread!.messages,
      }

  const openThread = useCallback(
    (id: ThreadId, fromUser = false) => {
      navGen.current += 1
      if (fromUser) onInteract?.()
      setThreadId(id)
      setVisible(0)
      setTyping(false)
      setPhase('thread')
      if (fromUser && isAgentId(id)) {
        skipFocusSync.current = true
        onFocusChange?.(id)
      }
    },
    [onFocusChange, onInteract],
  )

  const goInbox = useCallback(() => {
    navGen.current += 1
    onInteract?.()
    setPhase('inbox')
    setVisible(0)
    setTyping(false)
  }, [onInteract])

  // Stage tabs / auto-rotate open that agent (ignore echoes from phone taps)
  useEffect(() => {
    if (skipFocusSync.current) {
      skipFocusSync.current = false
      return
    }
    const gen = ++navGen.current
    setThreadId(focus)
    setVisible(0)
    setTyping(false)
    setPhase('inbox')
    const t = window.setTimeout(() => {
      if (navGen.current !== gen) return
      setThreadId(focus)
      setVisible(0)
      setTyping(false)
      setPhase('thread')
    }, 1200)
    return () => clearTimeout(t)
  }, [focus])

  useEffect(() => {
    if (phase !== 'thread') return

    const msgs = active.messages
    if (visible >= msgs.length) return

    const next = msgs[visible]
    let timer = 0
    if (next.from === 'them') {
      setTyping(true)
      timer = window.setTimeout(() => {
        setTyping(false)
        setVisible((v) => v + 1)
      }, 900)
    } else {
      timer = window.setTimeout(() => setVisible((v) => v + 1), 700)
    }
    return () => clearTimeout(timer)
  }, [phase, visible, active.messages])

  const rows = [
    ...AGENTS.map((a) => ({
      key: a.id as ThreadId,
      name: a.imsgName,
      preview: a.preview,
      time: a.time,
      color: a.color,
      mood: a.mood,
      initial: a.initial,
      face: true as const,
      unread: a.unread,
    })),
    ...OTHER_THREADS.map((t) => ({
      key: t.id as ThreadId,
      name: t.name,
      preview: t.preview,
      time: t.time,
      color: t.color,
      mood: 'soft' as const,
      initial: t.initial,
      face: false as const,
      unread: false,
    })),
  ]

  const shown = active.messages.slice(0, visible)
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
            {phase === 'inbox' && (
              <motion.div
                key="inbox"
                className="imsg-view imsg-view--inbox"
                initial={{ opacity: 0, x: -18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -36 }}
                transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              >
                <div className="inbox-top">
                  <div className="inbox-top__row">
                    <button type="button" className="inbox-pill">
                      Edit
                    </button>
                    <button type="button" className="inbox-pill inbox-pill--icon" aria-label="Filters">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M4 6h16v2H4V6zm3 5h10v2H7v-2zm3 5h4v2h-4v-2z" />
                      </svg>
                    </button>
                  </div>
                  <h2 className="inbox-title">Messages</h2>
                </div>

                <div className="inbox-list" role="list">
                  {rows.map((row, i) => (
                    <motion.button
                      key={row.key}
                      type="button"
                      role="listitem"
                      className={`inbox-row${row.unread ? ' inbox-row--unread' : ''}`}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.04 * i, duration: 0.25 }}
                      onClick={() => openThread(row.key, true)}
                    >
                      <div className="inbox-unread-dot" />
                      <div className="inbox-avatar" style={{ background: 'transparent', padding: 0 }}>
                        {row.face ? (
                          <AlphaFace color={row.color} mood={row.mood} size={44} />
                        ) : (
                          <span style={{ background: row.color }} className="inbox-avatar__fallback">
                            {row.initial}
                          </span>
                        )}
                      </div>
                      <div className="inbox-meta">
                        <div className="inbox-meta__top">
                          <span className="inbox-meta__name">{row.name}</span>
                          <span className="inbox-meta__time">
                            {row.time}
                            <svg viewBox="0 0 8 14" width="7" height="11" aria-hidden>
                              <path
                                d="M1 1l5 6-5 6"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                        </div>
                        <p className="inbox-meta__preview">{row.preview}</p>
                      </div>
                    </motion.button>
                  ))}
                </div>

                <div className="inbox-dock" aria-hidden>
                  <div className="inbox-dock__search">
                    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
                      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
                      <path d="M12.5 12.5L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                    <span>Search</span>
                    <svg className="inbox-dock__mic" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z" />
                    </svg>
                  </div>
                  <button type="button" className="inbox-dock__compose" aria-label="New message">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
                      <path
                        d="M6 4.75h8.25A2.25 2.25 0 0 1 16.5 7v8.25A2.25 2.25 0 0 1 14.25 17.5H6A2.25 2.25 0 0 1 3.75 15.25V7A2.25 2.25 0 0 1 6 4.75z"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      />
                      <path
                        d="M13.2 5.8l5 5M10.2 16.2H7.8v-2.4l7.35-7.35 2.4 2.4-7.35 7.35z"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </motion.div>
            )}

            {phase === 'thread' && (
              <motion.div
                key={`thread-${active.id}`}
                className="imsg-view imsg-view--thread"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 40 }}
                transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              >
                <div className="thread-bar">
                  <button type="button" className="thread-back" aria-label="Back to Messages" onClick={goInbox}>
                    <svg viewBox="0 0 12 20" width="10" height="16">
                      <path
                        d="M10 2L2 10l8 8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="thread-back__count">68</span>
                  </button>
                  <div className="thread-who">
                    {active.face ? (
                      <AlphaFace color={active.color} mood={active.mood} size={42} />
                    ) : (
                      <span className="thread-avatar" style={{ background: active.color }}>
                        {active.initial}
                      </span>
                    )}
                    <div className="thread-who__text">
                      <strong>
                        {active.name}
                        <svg viewBox="0 0 8 14" width="6" height="9" aria-hidden>
                          <path
                            d="M1 1l5 6-5 6"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </strong>
                    </div>
                  </div>
                  <button type="button" className="thread-facetime" aria-label="FaceTime">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h7A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 16.5v-9zm13.2 2.1 3.3-2.2a.8.8 0 0 1 1.3.7v7.8a.8.8 0 0 1-1.3.7l-3.3-2.2v-4.8z" />
                    </svg>
                  </button>
                </div>

                <div className="thread-body">
                  <p className="thread-secure">
                    <svg viewBox="0 0 12 14" width="9" height="10" aria-hidden>
                      <path
                        fill="currentColor"
                        d="M6 0a3.5 3.5 0 0 0-3.5 3.5V5H2a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H9.5V3.5A3.5 3.5 0 0 0 6 0zm0 2a1.5 1.5 0 0 1 1.5 1.5V5h-3V3.5A1.5 1.5 0 0 1 6 2z"
                      />
                    </svg>
                    iMessage
                    <span aria-hidden>·</span>
                    Encrypted
                  </p>
                  <p className="thread-stamp">Today 9:41 AM</p>
                  <AnimatePresence initial={false}>
                    {shown.map((m, i) => {
                      const prev = shown[i - 1]
                      const next = shown[i + 1]
                      const stackedTop = prev && prev.from === m.from
                      const stackedBottom = next && next.from === m.from
                      return (
                        <motion.div
                          key={`${active.id}-${i}`}
                          className={[
                            'bubble',
                            `bubble--${m.from}`,
                            m.kind === 'action' ? 'bubble--rich' : '',
                            stackedTop ? 'bubble--stack-top' : '',
                            stackedBottom ? 'bubble--stack-bottom' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          initial={{ opacity: 0, y: 10, scale: 0.96 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          transition={{ type: 'spring', stiffness: 480, damping: 32 }}
                        >
                          {m.kind === 'action' ? (
                            <div className="imsg-rich">
                              <div className="imsg-rich__app">
                                <span
                                  className={`imsg-rich__glyph imsg-rich__glyph--${(m.app || 'app').toLowerCase()}`}
                                  aria-hidden
                                />
                                <span>{m.app}</span>
                              </div>
                              {m.title && <p className="imsg-rich__title">{m.title}</p>}
                              <p className="imsg-rich__text">{m.text}</p>
                            </div>
                          ) : (
                            m.text
                          )}
                        </motion.div>
                      )
                    })}
                  </AnimatePresence>
                  {typing && <TypingDots />}
                  {lastIsMe && <p className="thread-delivered">Delivered</p>}
                </div>

                <div className="thread-composer">
                  <button type="button" className="composer-plus" aria-label="Apps">
                    <svg viewBox="0 0 24 24" width="28" height="28">
                      <circle cx="12" cy="12" r="11" fill="#8e8e93" />
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

          {phase === 'inbox' && <div className="phone__home phone__home--inbox" aria-hidden />}
        </div>
      </div>
    </div>
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
  const [hire, setHire] = useState<AgentId>('friend')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [myCode, setMyCode] = useState('')
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
    if (!phoneValue || !emailValue || !emailValue.includes('@')) return
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
          ...(code.trim() ? { code: code.trim() } : {}),
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(data.error || 'Could not save your info. Try again.')
        setBusy(false)
        return
      }
      setDone(true)
      track('waitlist_joined', { hire, via: code.trim() ? 'invite' : 'direct' })
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

  async function checkoutChosenPlan() {
    if (!plan || plan.tier === 'free') return
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          hire: 'friend',
          plan: plan.annual ? `${plan.tier}-annual` : plan.tier,
          trial_days: 7,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (data.url) {
        window.location.href = data.url
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
        You're in. {line.label} will reach out in about a minute. If nothing lands, text hi to{' '}
        {line.phoneDisplay} and the conversation starts there.
        {plan && plan.tier !== 'free' && (
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
        <p className="waitlist-success__cta">Text Alpha now</p>
        <a className="btn btn--accent" href="sms:+14155951440">
          Open Messages
        </a>
        <p style={{ margin: '10px 0 0' }}>
          <a className="btn btn--ghost" href="/api/contact/alpha.vcf">
            Save Alpha's contact
          </a>
        </p>
        <div className="qr">
          <img
            src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=sms%3A%2B14155951440"
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
      />
      <form className="waitlist-form" onSubmit={onSubmit}>
        <input
          type="tel"
          placeholder="(555) 555-0100"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-label="Your phone number"
          disabled={busy}
          autoComplete="tel"
        />
        <button type="submit" className="btn btn--accent" disabled={busy}>
          {busy ? 'Saving…' : 'Get my invite'}
        </button>
      </form>
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
            ? `${HIRE_LINES[hire].label} is in the workshop. Alpha the Friend is live: your number, email, and password get the invite the day both ship.`
            : `Number and email in, ${HIRE_LINES[hire].label} texts you first. iPhone Messages. Early access. $19 a month when you hire.`}
        </p>
      )}
    </>
  )
}

export default function Landing() {
  const [scrolled, setScrolled] = useState(false)
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
              {/* <a href="/app" className="btn btn--ghost btn--sm">
                App
              </a> */}
              <a href="#pricing" className="btn btn--primary btn--sm">
                Get started
              </a>
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
              <span>checked you in. flight lands 6:15 now</span>
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
              <a href="#pricing" className="btn btn--primary btn--lg">
                Hire Alpha
              </a>
              <a href="#waitlist" className="stage__dock-free">
                or start free
              </a>
              <p>Live now. Texts you in under a minute. iPhone Messages.</p>
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
            <a href="/contact">Contact</a>
            <a href="/developers">Developers</a>
          </nav>
          <p className="footer__copy">© {new Date().getFullYear()} HireAlpha</p>
        </div>
      </footer>
    </>
  )
}
