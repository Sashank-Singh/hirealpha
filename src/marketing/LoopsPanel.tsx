import { useCallback, useEffect, useState } from 'react'
import { toE164 } from './phone'
import { nextRunLabel } from './format'

type Loop = { id: string; kind: string; title: string; status: string; next_run: string | null }

/** What the hires are doing on a schedule, and the off switch for each one. */
export function LoopsPanel({ phone: phoneProp }: { phone?: string }) {
  const [phone, setPhone] = useState(phoneProp || '')
  const [loops, setLoops] = useState<Loop[] | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setPhone(phoneProp || '')
  }, [phoneProp])

  const e164 = toE164(phone)

  const load = useCallback(async (value: string) => {
    if (!value) return
    setLoaded(false)
    setError('')
    try {
      const res = await fetch(`/api/loops?phone=${encodeURIComponent(value)}`)
      const data = (await res.json().catch(() => ({}))) as { loops?: Loop[] }
      if (!res.ok) throw new Error(String(res.status))
      setLoops(Array.isArray(data.loops) ? data.loops : [])
    } catch {
      setLoops(null)
      setError('Could not load loops. Try again in a minute.')
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load(e164)
  }, [e164, load])

  async function toggle(loop: Loop) {
    const pause = loop.status !== 'paused'
    setBusyId(loop.id)
    try {
      const res = await fetch(`/api/loops/${encodeURIComponent(loop.id)}/${pause ? 'pause' : 'resume'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: e164 }),
      })
      if (!res.ok) throw new Error(String(res.status))
      await load(e164)
    } catch {
      setError('Could not change that loop. Try again.')
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="loops">
      {!e164 && (
        <input
          type="tel"
          className="kill__phone"
          placeholder="(555) 555-0100"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-label="Your phone number"
        />
      )}
      {e164 && !loaded && <p className="loops__empty">Checking your loops…</p>}
      {e164 && loaded && error && (
        <p className="kill__error" role="alert">
          {error}
        </p>
      )}
      {e164 && loaded && !error && (loops?.length ?? 0) === 0 && (
        <p className="loops__empty">No loops running. Ask a hire to watch something for you.</p>
      )}
      {e164 && loaded && !error && (loops?.length ?? 0) > 0 && (
        <ul className="loops__list">
          {loops!.map((loop) => (
            <li key={loop.id} className="loops__row">
              <div>
                <strong>{loop.title}</strong>
                <span>
                  {loop.kind}
                  {loop.status === 'paused' ? ' · paused' : ''}
                  {loop.status !== 'paused' && loop.next_run ? ` · ${nextRunLabel(loop.next_run, Date.now())}` : ''}
                </span>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busyId === loop.id}
                onClick={() => void toggle(loop)}
              >
                {loop.status === 'paused' ? 'Resume' : 'Pause'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
