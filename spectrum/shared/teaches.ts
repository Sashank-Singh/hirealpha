/**
 * Contextual capability teaches (experience-gap P4): one line, attached to the
 * moment the capability is relevant, shown at most a couple of times per
 * account and never twice in a row. Not a tutorial — each teach rides an
 * adjacent real event (a send, a price search, a login handoff, a renewal
 * ping, an upcoming meeting).
 */
import { upsertFacts, type ThreadMemory } from './memory'

export type TeachKind = 'followup_watch' | 'price_watch' | 'twofa_relay' | 'renewal_radar' | 'meeting_prep' | 'inbox_actions'

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000
const MAX_SHOWS = 2

export const TEACH_LINES: Record<TeachKind, string> = {
  followup_watch: "I can watch this thread and remind you if they don't reply — just say the word.",
  price_watch: 'I can keep watching this and text you if it changes.',
  twofa_relay: 'If a 2FA code arrives, text me the code here and I type it in for you.',
  renewal_radar: 'This is your renewal radar: I scan your mail daily and flag charges before they hit.',
  meeting_prep: 'I can pull the person, your recent emails, and talking points before any meeting. Say prep.',
  inbox_actions: 'I can file mail too: say archive, mark read, or trash with the number.',
}

/** The teach line for a kind, or null when this account has seen it enough. */
export function teachLine(kind: TeachKind, memory: ThreadMemory, now = Date.now()): string | null {
  const key = `teach_${kind}`
  const shown = memory.facts.find((f) => f.key === key)
  if (shown) {
    const lastSeen = Number(shown.lastSeen || shown.ts || 0)
    const count = Number(shown.value || 0)
    if (count >= MAX_SHOWS) return null
    if (Number.isFinite(lastSeen) && now - lastSeen < COOLDOWN_MS) return null
  }
  return TEACH_LINES[kind]
}

/** Record that a teach was shown; container-local, mirrored to the server by
 * the normal fact reconciliation so a fresh container does not re-teach. */
export function recordTeach(kind: TeachKind, dataDir: string, senderId: string, memory: ThreadMemory, now = Date.now()): void {
  const key = `teach_${kind}`
  const shown = memory.facts.find((f) => f.key === key)
  const count = Math.min(MAX_SHOWS, Number(shown?.value || 0) + 1)
  upsertFacts(dataDir, senderId, [{ key, value: String(count), ts: now, lastSeen: now }])
}
