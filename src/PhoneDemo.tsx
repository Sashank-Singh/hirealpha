import { motion, AnimatePresence } from 'framer-motion'
import { useState, useEffect, useCallback, useRef, useLayoutEffect, type ReactNode } from 'react'
import { AlphaFace } from './AlphaFace'

export type AgentId = 'friend' | 'coworker' | 'cofounder'

interface Msg {
  text: string
  from: 'me' | 'them'
  kind?: 'text' | 'action'
  app?: string
  title?: string
  image?: string
}

export interface Agent {
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

export const AGENTS: Agent[] = [
  {
    id: 'friend',
    name: 'Friend',
    imsgName: 'Alpha',
    role: 'Personal Assistant',
    initial: 'A',
    color: '#2a6f7a',
    mood: 'soft',
    pitch:
      'The friend who already knows your people. Texts first. Lives next to Mom in Messages.',
    preview: 'Checked you in. Boarding pass is in Wallet.',
    time: '2m',
    unread: true,
    messages: [
      { text: 'check me in for AA248 tomorrow', from: 'me' },
      { text: 'Checked you in. Boarding pass is in Wallet. Flight is on time.', from: 'them' },
      {
        text: 'AA248 · JFK, seat 14C · gate B12',
        from: 'them',
        kind: 'action',
        app: 'Wallet',
        title: 'Boarding pass · 8:35 AM departure',
      },
      { text: 'you read my mind', from: 'me' },
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

export function PhoneDemo({
  focus,
  onFocusChange,
  onInteract,
  tour,
}: {
  focus: AgentId
  onFocusChange?: (id: AgentId) => void
  onInteract?: () => void
  tour?: { progress: number; content: ReactNode; onProgressChange?: (progress: number) => void }
}) {
  const [phase, setPhase] = useState<'inbox' | 'thread'>(tour ? 'thread' : 'inbox')
  const [threadId, setThreadId] = useState<ThreadId>(focus)
  const [visible, setVisible] = useState(0)
  const [typing, setTyping] = useState(false)
  const skipFocusSync = useRef(false)
  const navGen = useRef(0)
  const tourBody = useRef<HTMLDivElement>(null)
  const syncingTourScroll = useRef(false)

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
    if (tour) {
      setPhase('thread')
      setVisible(AGENTS.find((agent) => agent.id === focus)?.messages.length ?? 0)
      return
    }
    setPhase('inbox')
    const t = window.setTimeout(() => {
      if (navGen.current !== gen) return
      setThreadId(focus)
      setVisible(0)
      setTyping(false)
      setPhase('thread')
    }, 1200)
    return () => clearTimeout(t)
  }, [focus, !!tour])

  useEffect(() => {
    if (tour || phase !== 'thread') return

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
  }, [phase, visible, active.messages, tour])

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

  useLayoutEffect(() => {
    const body = tourBody.current
    if (!tour || !body) return
    const maxScroll = body.scrollHeight - body.clientHeight
    const target = maxScroll * tour.progress
    if (Math.abs(body.scrollTop - target) < 1) return
    syncingTourScroll.current = true
    body.scrollTop = target
    requestAnimationFrame(() => { syncingTourScroll.current = false })
  }, [tour?.progress])

  const handleTourScroll = () => {
    const body = tourBody.current
    if (!tour || !body || syncingTourScroll.current || !tour.onProgressChange) return
    const maxScroll = body.scrollHeight - body.clientHeight
    if (maxScroll <= 0) return
    const nextProgress = body.scrollTop / maxScroll
    if (Math.abs(nextProgress - tour.progress) > 0.01) tour.onProgressChange(nextProgress)
  }

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
                key={tour ? 'thread-tour' : `thread-${active.id}`}
                className="imsg-view imsg-view--thread"
                initial={tour ? false : { opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={tour ? undefined : { opacity: 0, x: 40 }}
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

                <div ref={tourBody} onScroll={handleTourScroll} className="thread-body">
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
                  {tour ? tour.content : <>
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
                              {m.image && (
                                <div className="imsg-rich__thumb">
                                  <img src={m.image} alt={m.title || m.app || ''} />
                                </div>
                              )}
                              <div className="imsg-rich__app">
                                <span
                                  className={`imsg-rich__glyph imsg-rich__glyph--${(m.app || 'app').toLowerCase().replace(/\s+/g, '-')}`}
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
                  </>}
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
