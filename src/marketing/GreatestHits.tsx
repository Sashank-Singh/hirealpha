import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

function MiniAppPreview({ kind }: { kind: typeof EXAMPLES[number]['app'] }) {
  const title = EXAMPLES.find((example) => example.app === kind)?.label ?? 'Alpha app'
  return (
    <div className={`tour-app tour-app--${kind}`}>
      <div className="tour-app__top"><span className="tour-app__mark" aria-hidden="true" /><span>{title}</span><small>ALPHA</small></div>
      {kind === 'pick_night' && <>
        <strong className="tour-app__headline">Your day, wrapped.</strong>
        <div className="tour-app__metrics"><span><b>6h</b><small>sleep</small></span><span><b>142g</b><small>protein</small></span><span><b>3</b><small>calls closed</small></span></div>
        <div className="tour-app__note"><i /> 2 things to clear tonight</div>
      </>}
      {kind === 'nutrition' && <>
        <div className="tour-app__split"><strong>Today’s nutrition</strong><b>+620 <small>kcal</small></b></div>
        <div className="tour-app__meter"><i style={{ width: '75%' }} /></div>
        <div className="tour-app__split tour-app__muted"><span>Protein <b>112 / 150g</b></span><span>48g added</span></div>
        <div className="tour-app__tags"><span>Protein 48g</span><span>Carbs 42g</span><span>Fat 24g</span></div>
      </>}
      {kind === 'sleep_tracker' && <>
        <div className="tour-app__sleep-score"><strong>5h 40m</strong><span><b>64</b><small> recovery</small></span></div>
        <div className="tour-app__sleep-bars"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
        <div className="tour-app__split tour-app__muted"><span>Woke twice</span><b>Strength moved · 6 PM</b></div>
      </>}
      {kind === 'habit_streak' && <>
        <div className="tour-app__split"><strong>Today’s streaks</strong><b className="tour-app__flame">15 days</b></div>
        <div className="tour-app__habit"><span className="tour-app__check">✓</span><span>Read for 20 minutes</span><b>Done</b></div>
        <div className="tour-app__habit"><span className="tour-app__check">✓</span><span>No screens in bed</span><b>Day 15</b></div>
        <div className="tour-app__note">Morning runs · 4 day streak</div>
      </>}
      {kind === 'artifact' && <>
        <div className="tour-app__game-head"><span><b>Ping Pong</b><small>Made for you · just now</small></span><span className="tour-app__score">00 : 00</span></div>
        <div className="tour-app__game"><i /><i /><b /></div>
        <div className="tour-app__split tour-app__muted"><span>Touch controls</span><b>Ready to play ↗</b></div>
      </>}
      {kind === 'tonight' && <>
        <div className="tour-app__movie"><span className="tour-app__movie-mark">70<span>mm</span></span><span><strong>Odyssey</strong><small>IMAX · Friday</small></span></div>
        <div className="tour-app__ticket-row"><span>AMC Metreon 16</span><b>7:15 PM</b></div>
        <div className="tour-app__split tour-app__muted"><span>Row F · 2 seats left</span><b>View tickets ↗</b></div>
      </>}
      {kind === 'spending_snapshot' && <>
        <div className="tour-app__split"><strong>Chase · Recent activity</strong><b>Yesterday</b></div>
        <div className="tour-app__transaction"><span className="tour-app__transaction-dot" /><span>Gym membership<small>Checking · posted</small></span><b>−$180</b></div>
        <div className="tour-app__transaction tour-app__transaction--flag"><span className="tour-app__transaction-dot" /><span>Figma<small>Possible duplicate</small></span><b>−$29</b></div>
        <div className="tour-app__note">Refund email drafted · review first</div>
      </>}
      {kind === 'standup_paste' && <>
        <div className="tour-app__standup-title"><strong>Today’s standup</strong><span>From GitHub · just now</span></div>
        <div className="tour-app__standup-row"><b>YESTERDAY</b><span>Auth refactor shipped · 3 fixes · DB review</span></div>
        <div className="tour-app__standup-row"><b>TODAY</b><span>Stripe webhooks & checkout tests</span></div>
        <div className="tour-app__split tour-app__muted"><span>Blockers · none</span><b>Copy standup ↗</b></div>
      </>}
      {kind === 'decision_ledger' && <>
        <div className="tour-app__decision"><span>DECISION LOG · TODAY</span><strong><i>KILL</i> $12k/mo agency proposal</strong></div>
        <div className="tour-app__note">Why: 5 enterprise pilots came from outbound.</div>
        <div className="tour-app__split tour-app__muted"><span>Runway protected</span><b>11 months ↗</b></div>
      </>}
    </div>
  )
}

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
              <Fragment key={index}>
                <div
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
                {cardBubble === bubble && (
                  <a className="conversation-tour__app-card" href={appUrl} aria-label={`Open ${item.label} mini app`}>
                    <MiniAppPreview kind={item.app} />
                  </a>
                )}
              </Fragment>
            ))}
            {cardBubble && !bubbles.includes(cardBubble) && (
              <a className="conversation-tour__app-card" href={appUrl} aria-label={`Open ${item.label} mini app`}>
                <MiniAppPreview kind={item.app} />
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
          <div
            className="conversation-tour__pet-card"
            aria-live="polite"
            style={{ translate: `${-8 + progress * 26}px 0` }}
          >
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
