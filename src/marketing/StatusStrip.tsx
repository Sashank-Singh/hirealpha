import { useEffect, useState } from 'react'
import { formatReply } from './format'

type HireStatus = { up: boolean; lastReplyMs: number | null }
type HireId = 'friend' | 'coworker' | 'cofounder'
type StatusPayload = { hires?: Partial<Record<HireId, HireStatus>> }

const HIRE_LABELS: HireId[] = ['friend', 'coworker', 'cofounder']

/** Live dots for the three hires. Says nothing when the endpoint is not up yet. */
export function StatusStrip() {
  const [hires, setHires] = useState<Partial<Record<HireId, HireStatus>> | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/status')
      .then((res) => (res.ok ? (res.json() as Promise<StatusPayload>) : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (live && data.hires) setHires(data.hires)
      })
      .catch(() => {
        // No status endpoint yet. The strip just stays hidden.
      })
    return () => {
      live = false
    }
  }, [])

  if (!hires) return null

  return (
    <div className="container">
      <p className="status-strip" role="status">
        {HIRE_LABELS.map((id) => {
          const s = hires[id]
          if (!s) return null
          const reply = formatReply(s.lastReplyMs)
          return (
            <span key={id} className="status-strip__item">
              <span className={`status-dot${s.up ? ' is-up' : ' is-down'}`} aria-hidden />
              {id.charAt(0).toUpperCase() + id.slice(1)} {s.up ? 'up' : 'down'}
              {s.up && reply ? `, last reply ${reply}` : ''}
            </span>
          )
        })}
      </p>
    </div>
  )
}
