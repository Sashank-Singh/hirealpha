import { useEffect, useState } from 'react'
import { toE164 } from './phone'

type KillState = { armed?: boolean; error?: string }

/** One switch that quiets every hire. Nothing sends or spends while it is armed. */
export function KillSwitch({ phone: phoneProp }: { phone?: string }) {
  const [phone, setPhone] = useState(phoneProp || '')
  const [armed, setArmed] = useState<boolean | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setPhone(phoneProp || '')
  }, [phoneProp])

  const e164 = toE164(phone)

  useEffect(() => {
    if (!e164) return
    let live = true
    setLoaded(false)
    fetch(`/api/kill-switch?phone=${encodeURIComponent(e164)}`)
      .then((res) => (res.ok ? (res.json() as Promise<KillState>) : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!live) return
        setArmed(!!data.armed)
        setLoaded(true)
      })
      .catch(() => {
        if (live) setLoaded(true)
      })
    return () => {
      live = false
    }
  }, [e164])

  async function stop() {
    if (!e164) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: e164 }),
      })
      const data = (await res.json().catch(() => ({}))) as KillState
      if (!res.ok) {
        setError(data.error || 'Could not stop anything. Try again.')
      } else {
        setArmed(!!data.armed)
        setConfirming(false)
      }
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kill">
      <p className="kill__state" role="status">
        <span className={`status-dot${armed ? ' is-down' : loaded ? ' is-up' : ''}`} aria-hidden />
        {!e164
          ? 'Confirm your number to see the switch.'
          : armed
            ? 'Everything is stopped. Text your hire to turn it back on.'
            : loaded
              ? 'Everything is running.'
              : 'Checking the switch…'}
      </p>
      {!armed && (
        <>
          {!confirming ? (
            <button type="button" className="kill__btn" onClick={() => setConfirming(true)} disabled={!e164}>
              Stop everything
            </button>
          ) : (
            <div className="kill__confirm">
              <p>All hires go quiet until you turn them back on. Stop?</p>
              <button type="button" className="kill__btn" onClick={() => void stop()} disabled={busy}>
                {busy ? 'Stopping…' : 'Yes, stop'}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)}>
                Keep going
              </button>
            </div>
          )}
        </>
      )}
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
      {error && (
        <p className="kill__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
