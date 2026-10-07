import { useEffect, useRef, useState } from 'react'

const MORNING_STEPS = [
  'Syncing Google Calendar & schedule',
  'Scanning Gmail & unread threads',
  'Filtering priority requests waiting on you',
  'Structuring your day & commitments',
]

const EVENING_STEPS = [
  'Reviewing today’s calendar & completed meets',
  'Scanning inbox for mail since morning',
  'Carrying open loops & promises forward',
  'Finalizing evening debrief & score',
]

export function BriefLoading({
  evening = false,
  attempt = 0,
}: {
  evening?: boolean
  attempt?: number
}) {
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
    }, 1200)
    return () => window.clearInterval(id)
  }, [evening, reduceMotion, steps.length])

  return (
    <div className="brief-loading" role="status" aria-live="polite">
      <div className="brief-loading__top">
        <span className="brief-loading__kicker">{evening ? 'Evening debrief' : 'Morning brief'}</span>
        <span className="brief-loading__count">
          Step {current + 1} of {steps.length}
        </span>
      </div>

      <h2 className="brief-loading__title">
        {evening ? 'Preparing your evening summary…' : 'Preparing your morning brief…'}
      </h2>

      <div className="brief-loading__track" aria-hidden="true">
        <span
          className="brief-loading__bar"
          style={{ width: `${((current + 1) / steps.length) * 100}%` }}
        />
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
                {done ? (
                  <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
                  </svg>
                ) : active ? (
                  <span className="brief-activity-dot" />
                ) : null}
              </span>
              <span className="brief-activity-label">{label}</span>
            </li>
          )
        })}
      </ul>

      {current === steps.length - 1 && (
        <p className="brief-loading__aside">Your briefing will appear as soon as data arrives.</p>
      )}
    </div>
  )
}
