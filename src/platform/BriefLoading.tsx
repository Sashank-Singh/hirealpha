import { useEffect, useRef, useState } from 'react'

const MORNING_STEPS = [
  'Reading your calendar',
  'Checking the inbox',
  'Finding what needs you',
  'Setting today’s priorities',
  'Writing your brief',
]

const EVENING_STEPS = [
  'Reviewing what got done',
  'Checking the rest of today',
  'Reading new mail',
  'Carrying open work forward',
  'Closing out your brief',
]

export function BriefLoading({ evening = false, attempt = 0 }: { evening?: boolean; attempt?: number }) {
  const reduceMotion = useRef(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  ).current
  const [elapsedStep, setElapsedStep] = useState(0)
  const steps = evening ? EVENING_STEPS : MORNING_STEPS
  const current = reduceMotion ? 0 : Math.min(steps.length - 1, Math.max(elapsedStep, attempt))

  useEffect(() => {
    setElapsedStep(0)
    if (reduceMotion) return
    const id = window.setInterval(() => {
      setElapsedStep((step) => Math.min(steps.length - 1, step + 1))
    }, 900)
    return () => window.clearInterval(id)
  }, [evening, reduceMotion, steps.length])

  return (
    <div className="brief-loading" role="status" aria-live="polite">
      <div className="brief-loading__top">
        <span className="brief-loading__kicker">{evening ? 'Evening brief' : 'Morning brief'}</span>
        <span className="brief-loading__count">{current + 1} of {steps.length}</span>
      </div>
      <h2 className="brief-loading__title">
        {evening ? 'Closing out your day' : 'Pulling your day together'}
        <span className="brief-loading__ellipsis" aria-hidden="true">…</span>
      </h2>
      <div className="brief-loading__track" aria-hidden="true">
        <span style={{ width: `${((current + 1) / steps.length) * 100}%` }} />
      </div>
      <ul className="brief-activity">
        {steps.map((label, index) => {
          const done = index < current
          const active = index === current
          return (
            <li
              key={label}
              className={`brief-activity-step${active ? ' is-current' : ''}${done ? ' is-done' : ''}`}
            >
              <span className="brief-activity-mark" aria-hidden="true">
                {done ? '✓' : active ? <span className="brief-activity-dot" /> : null}
              </span>
              <span className="brief-activity-label">{label}</span>
            </li>
          )
        })}
      </ul>
      {current === steps.length - 1 && (
        <p className="brief-loading__aside">Your brief will appear here as soon as it is ready.</p>
      )}
    </div>
  )
}
