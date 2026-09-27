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

type ScheduledClaim = { id: string; claimToken: string; toPhone: string; ownerPhone?: string; body: string }

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
  send: (phone: string, text: string) => Promise<void | string | { providerId?: string }>,
  intervalMs = PROACTIVE_POLL_MS,
): void {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) {
    console.log(`[${persona}] scheduled-text poller off (HIREALPHA_API_URL or internal key missing)`)
    return
  }

  const post = async (path: string, body: Record<string, unknown>): Promise<boolean> => {
    try {
      const response = await fetch(`${base}/api/internal/scheduled_texts/${path}`, {
        signal: AbortSignal.timeout(10_000),
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.ok
    } catch (err) {
      console.error(`[${persona}] scheduled-text ack failed`, err)
      return false
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
        if (!await post('begin', { id: claim.id, claimToken: claim.claimToken })) continue
        const delivery = await send(claim.toPhone, claim.body)
        const providerId = typeof delivery === 'string' ? delivery : delivery?.providerId
        console.log(`[${persona}] scheduled text sent to ${claim.toPhone}`)
        await post('ack', { id: claim.id, claimToken: claim.claimToken, ok: true, providerId })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[${persona}] scheduled text to ${claim.toPhone} failed: ${message}`)
        await post('ack', { id: claim.id, claimToken: claim.claimToken, ok: false, error: message })
        if (claim.ownerPhone) {
          try { await send(claim.ownerPhone, `Your scheduled message to ${claim.toPhone} failed: ${message.slice(0, 160)}. It was not marked sent.`) } catch {}
        }
      }
    }
  }

  const run = () => {
    tick().catch((err) => console.error(`[${persona}] scheduled-text tick failed`, err))
  }
  run()
  setInterval(run, intervalMs)
}
