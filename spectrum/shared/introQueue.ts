import type { AgentId } from '../../src/agents'

/** First text each hire sends a number that signed up on the site. One source
 * of truth here; the per-bot index files used to hardcode their own copy. */
export const INTRO_TEXTS: Record<AgentId, string> = {
  friend: "Hey. I'm Alpha. You hired me as your friend in texts. Vent, plan, check in. I'm here.",
  coworker:
    'Hey. Alpha (Coworker). You hired me as your work colleague. Standups, agendas, follow ups. Send me the raw notes.',
  cofounder:
    "Hey. Alpha(CoFounder). You hired me as your startup partner. I'll push back when the plan is soft. What's the real decision this week?",
}

interface IntroClaim {
  id: string
  phone: string
}

interface IntroSender {
  (phone: string, text: string): Promise<void>
}

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}` }
}

/**
 * Polls the server for phone numbers that signed up for this hire and sends
 * each one the intro text, so a signup turns into a real iMessage thread
 * without anyone touching the Photon dashboard or an INTRO_TO env var.
 *
 * Send failures (shared Photon lines sometimes cannot cold-text a target) ack
 * with the error and retry on later polls up to the server's attempt cap; the
 * signup screen's fallback copy covers numbers that never receive the intro.
 */
export function startIntroPoller(options: {
  persona: AgentId
  send: IntroSender
  intervalMs?: number
}) {
  const { persona, send } = options
  const intervalMs = options.intervalMs ?? 30_000
  const base = apiBase()
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY) {
    console.log(`[${persona}] intro poller off: HIREALPHA_API_URL or HIREALPHA_INTERNAL_KEY missing`)
    return
  }

  const ack = async (id: string, ok: boolean, error?: string) => {
    try {
      await fetch(`${base}/api/internal/intros/ack`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ok, error }),
      })
    } catch (err) {
      console.error(`[${persona}] intro ack failed`, err)
    }
  }

  const tick = async () => {
    let claims: IntroClaim[] = []
    try {
      const res = await fetch(
        `${base}/api/internal/intros/claim?persona=${encodeURIComponent(persona)}&limit=3`,
        { headers: authHeaders() },
      )
      if (!res.ok) return
      const data = (await res.json()) as { intros?: IntroClaim[] }
      claims = data.intros || []
    } catch (err) {
      console.error(`[${persona}] intro claim failed`, err)
      return
    }

    for (const claim of claims) {
      try {
        await send(claim.phone, INTRO_TEXTS[persona])
        console.log(`[${persona}] intro sent to ${claim.phone}`)
        await ack(claim.id, true)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[${persona}] intro to ${claim.phone} failed: ${message}`)
        await ack(claim.id, false, message)
      }
    }
  }

  const run = () => {
    tick().catch((err) => console.error(`[${persona}] intro tick failed`, err))
  }
  run()
  setInterval(run, intervalMs)
}
