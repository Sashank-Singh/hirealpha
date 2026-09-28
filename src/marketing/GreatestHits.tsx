import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PhoneDemo, type AgentId } from '../PhoneDemo'
import { HIGHLIGHTS } from '../data/highlights'
import './conversation-tour.css'

const EXAMPLES = [
  { app: 'pick_night', label: 'Daily brief', messages: [1, 2, 3, 4] },
  { app: 'nutrition', label: 'Nutrition', messages: [0, 1, 2, 3] },
  { app: 'sleep_tracker', label: 'Sleep', messages: [0, 1, 2] },
  { app: 'habit_streak', label: 'Habits', messages: [0, 1, 2] },
  { app: 'artifact', label: 'Build an app', messages: [0, 1, 2, 3] },
  { app: 'tonight', label: 'Find tickets', messages: [0, 1, 2, 3] },
  { app: 'spending_snapshot', label: 'Spending', messages: [0, 1, 2, 3] },
  { app: 'standup_paste', label: 'Standup', messages: [0, 1, 2, 3] },
  { app: 'decision_ledger', label: 'Decisions', messages: [0, 1, 2, 3] },
 ] as const

const EXPLANATIONS = [
  'Your day’s loose ends and priorities, gathered into one quick brief.',
  'Describe or snap a meal. Alpha logs it and updates your macros.',
  'Turn last night’s sleep into recovery insights and a smarter plan.',
  'Tell Alpha what you did. Your habit log and streak update.',
  'Ask for a tiny game or tool. Alpha builds it and sends a link.',
  'Find a showtime and seats, then open the ticket link to book.',
  'Check charges, spot duplicates, and draft a refund request.',
  'Turn shipped work into a standup you can review and paste.',
  'Keep the decision and its reasoning easy to find later.',
]

export function GreatestHits() {
  const section = useRef<HTMLElement>(null)
  const [progress, setProgress] = useState(0)
  const [manual, setManual] = useState(false)
  const step = Math.min(8, Math.floor(progress * 9))
  const persona = HIGHLIGHTS[step].persona
  const syncPageToPhone = useCallback((nextProgress: number) => {
    setProgress(nextProgress)
    if (manual || !section.current) return
    const top = window.scrollY + section.current.getBoundingClientRect().top - 88
    const travel = section.current.offsetHeight - window.innerHeight + 88
    window.scrollTo({ top: top + travel * nextProgress, behavior: 'instant' })
  }, [manual])

  const transcript = useMemo(() => (
    <div className="conversation-tour__transcript">
      {HIGHLIGHTS.map((sample, sampleIndex) => {
        const item = EXAMPLES[sampleIndex]
        const bubbles = item.messages.map((index) => sample.bubbles[index]).filter(Boolean)
        const cardBubble = sample.bubbles.find((bubble) => bubble.linkPreview || bubble.card)
        const appUrl = sampleIndex === 4 ? '/b/ping-pong' : `/app/mini/${sample.persona}/${item.app}`
        const changedPersona = sampleIndex > 0 && HIGHLIGHTS[sampleIndex - 1].persona !== sample.persona
        return (
          <section className="conversation-tour__sample" key={sample.caption} aria-label={`${sample.caption} conversation`}>
            {changedPersona && <p className="conversation-tour__handoff">New thread · {sample.title}</p>}
            <p className="thread-stamp">{sample.caption}</p>
            {bubbles.map((bubble, index) => (
              <div
                key={index}
                className={[
                  'bubble',
                  `bubble--${bubble.from}`,
                  bubble.card ? 'bubble--rich' : '',
                  index > 0 && bubbles[index - 1].from === bubble.from ? 'bubble--stack-top' : '',
                  index + 1 < bubbles.length && bubbles[index + 1].from === bubble.from ? 'bubble--stack-bottom' : '',
                ].filter(Boolean).join(' ')}
              >
                {bubble.image && <img className="conversation-tour__image" src={bubble.image} alt="" />}
                {bubble.app && <span className="conversation-tour__app-label">{bubble.app}</span>}
                <span className="conversation-tour__sr">{bubble.from === 'me' ? 'You' : sample.title}: </span>{bubble.text}
              </div>
            ))}
            {cardBubble && (
              <a className="conversation-tour__app-card" href={appUrl}>
                <span>{item.label}</span>
                <strong>{cardBubble.card?.title ?? cardBubble.linkPreview?.title ?? item.label}</strong>
                <small>Open in Alpha ↗</small>
              </a>
            )}
          </section>
        )
      })}
    </div>
  ), [])

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce), (max-height: 700px)')
    let frame = 0
    const update = () => {
      frame = 0
      if (preference.matches || !section.current) return
      const rect = section.current.getBoundingClientRect()
      const travel = section.current.offsetHeight - window.innerHeight + 88
      setProgress(Math.max(0, Math.min(1, (88 - rect.top) / travel)))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const sync = () => { setManual(preference.matches); schedule() }
    sync()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', sync)
    preference.addEventListener('change', sync)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', sync)
      preference.removeEventListener('change', sync)
    }
  }, [])

  function goTo(next: number) {
    const nextProgress = next / 8
    setProgress(nextProgress)
    if (!manual && section.current) {
      const top = window.scrollY + section.current.getBoundingClientRect().top - 88
      const travel = section.current.offsetHeight - window.innerHeight + 88
      window.scrollTo({ top: top + travel * nextProgress, behavior: 'instant' })
    }
  }

  return (
    <section ref={section} className="hits conversation-tour" id="hits" aria-labelledby="hits-heading">
      <div className="conversation-tour__sticky container">
        <div className="conversation-tour__intro">
          <p className="hits__eyebrow">Nine things, one text away</p>
          <h2 id="hits-heading">Just ask.<br />Alpha gets it done.</h2>
          <p className="conversation-tour__duration">Nine real examples, from everyday life to work to the big calls.</p>
          <div className="conversation-tour__context">
            <p className="conversation-tour__availability">Friend <span>→</span> Coworker <span>→</span> Cofounder</p>
            <h3>One conversation. Real things handled.</h3>
          </div>
          <a className="conversation-tour__skip" href="#pricing">Skip to plans →</a>
        </div>

        <figure className="conversation-tour__figure">
          <div className="conversation-tour__pet-card" aria-live="polite">
            <div className="conversation-tour__pet" aria-hidden="true">
              <svg viewBox="0 0 64 64">
                <path className="pet__tail" d="M47 43c12-2 13 8 8 13-1-5-4-6-9-5" />
                <path className="pet__ear" d="M13 24 9 9c10 1 15 5 17 12m12 0c2-7 7-11 17-12l-4 15" />
                <path className="pet__body" d="M10 35c0-14 9-24 22-24s22 10 22 24-9 23-22 23S10 49 10 35Z" />
                <ellipse className="pet__muzzle" cx="32" cy="39" rx="13" ry="10" />
                <circle className="pet__eye" cx="24" cy="31" r="2.4" /><circle className="pet__eye" cx="40" cy="31" r="2.4" />
                <circle className="pet__cheek" cx="17" cy="39" r="3" /><circle className="pet__cheek" cx="47" cy="39" r="3" />
                <path className="pet__smile" d="M27 41c2 3 8 3 10 0" />
                <path className="pet__sparkle" d="M6 30v-5m-2.5 2.5h5M56 23v-5m-2.5 2.5h5" />
              </svg>
            </div>
            <div className="conversation-tour__pet-speech"><strong>Pip’s thought</strong><p>{EXPLANATIONS[step]}</p></div>
          </div>
          <div className="conversation-tour__device">
            <PhoneDemo
              focus={persona as AgentId}
              tour={{ progress, content: transcript, onProgressChange: syncPageToPhone }}
            />
          </div>
          <figcaption>Nine sample conversations · one phone</figcaption>
        </figure>

        <div className="conversation-tour__footer">
          <div className="conversation-tour__progress" aria-label={`Tour progress: ${step + 1} of 9`}><span style={{ width: `${(step + 1) / 9 * 100}%` }} /></div>
          <span>{step === 8 ? 'That’s all nine. Your turn.' : manual ? 'Use Next to move through the chat.' : 'Scroll to move through the chat.'}</span>
          {step === 8 ? <a href="#pricing">Choose your plan →</a> : <button type="button" onClick={() => goTo(step + 1)}>Next example →</button>}
        </div>
      </div>
    </section>
  )
}
