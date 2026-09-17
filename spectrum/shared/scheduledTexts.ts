/**
 * Scheduled send-on-behalf poller (the bot side of hire_scheduled_texts).
 * A user texts "wish mom happy birthday at midnight"; the capability stores a
 * due row; this loop claims it when the time arrives, registers the target
 * with Photon if it is a fresh number, sends through the same sender the
 * intro queue uses, and acks. Shape mirrors introQueue.ts on purpose.
 */
import type { AgentId } from '../../src/agents/types'
import { PROACTIVE_POLL_MS } from './delivery'
import { ensurePhotonUser } from './introQueue'

type ScheduledClaim = { id: string; toPhone: string; body: string }

function apiBase(): string {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}`,
    Accept: 'application/json',
  }
}

export function startScheduledTextPoller(
  persona: AgentId,
  send: (phone: string, text: string) => Promise<void>,
  intervalMs = PROACTIVE_POLL_MS,
): void {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) {
    console.log(`[${persona}] scheduled-text poller off (HIREALPHA_API_URL or internal key missing)`)
    return
  }

  const ack = async (id: string, ok: boolean, error?: string) => {
    try {
      await fetch(`${base}/api/internal/scheduled_texts/ack`, {
        signal: AbortSignal.timeout(10_000),
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ok, error }),
      })
    } catch (err) {
      console.error(`[${persona}] scheduled-text ack failed`, err)
    }
  }

  const tick = async () => {
    let due: ScheduledClaim[] = []
    try {
      const res = await fetch(
        `${base}/api/internal/scheduled_texts/claim?persona=${encodeURIComponent(persona)}`,
        { headers: authHeaders(), signal: AbortSignal.timeout(10_000) },
      )
      if (!res.ok) return
      const data = (await res.json()) as { due?: ScheduledClaim[] }
      due = data.due || []
    } catch (err) {
      console.error(`[${persona}] scheduled-text claim failed`, err)
      return
    }
    for (const claim of due) {
      try {
        await ensurePhotonUser(claim.toPhone, persona)
        await send(claim.toPhone, claim.body)
        console.log(`[${persona}] scheduled text sent to ${claim.toPhone}`)
        await ack(claim.id, true)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[${persona}] scheduled text to ${claim.toPhone} failed: ${message}`)
        await ack(claim.id, false, message)
      }
    }
  }

  const run = () => {
    tick().catch((err) => console.error(`[${persona}] scheduled-text tick failed`, err))
  }
  run()
  setInterval(run, intervalMs)
}
