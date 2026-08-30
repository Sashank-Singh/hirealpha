import type { AgentId } from '../../src/agents'

/* Conversational onboarding after the intro text. Pure state machine plus one
 * thin poster to /api/internal/memory, so the bot asks name, city, priority
 * in chat instead of making the signup fill a form. */

export type OnboardingStage = 'done' | 'name' | 'city' | 'priority'

export type OnboardingMemory = { key: string; value: string }

/* memoryMaintain's durable keys use preferred_name and city; the local fact
 * store also keeps a bare name key. Match both on read, write preferred_name. */
const NAME_KEYS = ['preferred_name', 'name']
const CITY_KEY = 'city'
const PRIORITY_KEY = 'priority'

export const CONNECTOR_SUGGEST_LINK = 'https://hirealpha.chat/app/settings?connect=gmail'

function factValue(memories: OnboardingMemory[], keys: string[]): string {
  for (const m of Array.isArray(memories) ? memories : []) {
    if (keys.includes(m?.key) && String(m?.value || '').trim()) return String(m.value).trim()
  }
  return ''
}

/** Missing name first, then city, then priority, then done. */
export function onboardingStage(memories: OnboardingMemory[]): OnboardingStage {
  if (!factValue(memories, NAME_KEYS)) return 'name'
  if (!factValue(memories, [CITY_KEY])) return 'city'
  if (!factValue(memories, [PRIORITY_KEY])) return 'priority'
  return 'done'
}

/** One short human question per stage. No dashes anywhere. */
export function nextOnboardingText(stage: OnboardingStage, draftName?: string | null): string {
  if (stage === 'name') return 'By the way, what should I call you?'
  if (stage === 'city') {
    const name = (draftName || '').trim()
    return name
      ? `Good to meet you, ${name}. What city are you in? It makes what I find you actually local.`
      : 'Good to meet you. What city are you in? It makes what I find you actually local.'
  }
  if (stage === 'priority') {
    return 'Last one. What should I help with most right now: food, training, people, work, or just someone to think out loud with?'
  }
  return ''
}

/** The line that closes onboarding once priority lands. */
export function onboardingDoneText(_priority?: string | null): string {
  return 'That is my job then. Talk anytime. I text first sometimes.'
}

const QUESTION_START = /^(what|who|when|where|why|how|can|could|would|should|do|does|did|are|is|will|hey|yo|hi|hello|thanks|thank)\b/i
const SMALL_TALK_START =
  /^(not|so|just|really|very|good|fine|ok|okay|great|tired|sad|happy|here|back|doing|feeling|gonna|going|the|a|an|this|that|it|its|i|my|we|you|me)\b/i
const COMMON_VERBS =
  /\b(am|is|are|was|were|think|thinks|want|wants|need|needs|can|could|would|should|will|do|does|did|have|has|had|like|likes|know|knows|say|says|tell|tells|ask|asks|help|helps|get|got|gets|make|makes|go|goes|going|come|comes|been|being|love|hate|feel|feels|just|really|also|looking|look|trying|try)\b/i

function cleanWord(raw: string): string {
  return raw.replace(/^[.,!?;:"'()\s]+|[.,!?;:"'()\s]+$/g, '').trim()
}

function isNameShaped(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 2) return false
  return words.every((w) => /^[A-Za-z][A-Za-z'’-]*$/.test(w))
}

/** Pull the answer for the current stage out of one text. Null when nothing
 * usable is there, so the caller just asks again. */
export function extractOnboardingAnswer(stage: OnboardingStage, text: string): string | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  if (stage === 'name') {
    // Sentences and questions are chat, not an answer.
    if (raw.includes('?')) return null
    const pattern = raw.match(/^(?:i'?m|i am|call me|my name(?:'s| is))\s+(.+)$/i)
    if (pattern) {
      const value = cleanWord(pattern[1] || '')
      if (
        value &&
        !QUESTION_START.test(value) &&
        !SMALL_TALK_START.test(value) &&
        !COMMON_VERBS.test(value) &&
        isNameShaped(value)
      ) {
        return value
      }
      return null
    }
    // Bare answer: the first 1 to 2 capitalized words only.
    if (QUESTION_START.test(raw) || COMMON_VERBS.test(raw)) return null
    const words = raw.split(/\s+/).map(cleanWord).filter(Boolean)
    if (!words.length || words.length > 4) return null
    if (SMALL_TALK_START.test(words[0]!)) return null
    const isCap = (w: string) => /^[A-Z][A-Za-z'’-]*$/.test(w)
    if (words.length <= 2 && words.every(isCap)) return words.join(' ')
    if (words.length <= 4 && isCap(words[0]!)) return words[0]!
    return null
  }
  if (stage === 'city') {
    let t = raw.replace(/[.!?]+$/, '').trim()
    t = t
      .replace(/^(?:i'?m|i am|i was)\s+in\s+/i, '')
      .replace(/^i\s+(?:live|am based|based|am)\s+in\s+/i, '')
      .replace(/^(?:based|living)\s+in\s+/i, '')
      .replace(/^(?:i\s+live\s+in|i'?m\s+from|i\s+am\s+from|from|in)\s+/i, '')
      .replace(/^(?:it'?s|i'?m)\s+in\s+/i, '')
      .trim()
    if (!t || t === raw) return null
    const words = t.split(/\s+/)
    if (words.length > 6) return null
    if (/\b(?:i|you|my|we|me|live|lives|from)\b/i.test(t)) return null
    return t
  }
  if (stage === 'priority') {
    const value = raw.slice(0, 40).trim()
    return value || null
  }
  return null
}

function memoryKeyForStage(stage: OnboardingStage): string {
  if (stage === 'name') return 'preferred_name'
  if (stage === 'city') return CITY_KEY
  return PRIORITY_KEY
}

async function postOnboardingFact(
  phone: string,
  persona: AgentId,
  key: string,
  value: string,
): Promise<void> {
  const base = (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
  const keyEnv = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !keyEnv) return
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      await fetch(`${base}/api/internal/memory`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyEnv}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone, persona, facts: [{ key, value }] }),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    console.warn('[onboarding] fact post failed', err)
  }
}

/** One onboarding turn. Extracts the answer for the current stage, persists it,
 * and returns the next question (or the done line). Null only when onboarding
 * is already finished. Never throws; works without env, just without persist. */
export async function runOnboardingTurn(
  phone: string,
  persona: AgentId,
  userText: string,
  memories: OnboardingMemory[],
): Promise<string | null> {
  try {
    const stage = onboardingStage(memories)
    if (stage === 'done') return null
    const answer = extractOnboardingAnswer(stage, userText)
    let draftName: string | null = null
    if (answer) {
      const key = memoryKeyForStage(stage)
      if (stage === 'name') draftName = answer
      await postOnboardingFact(phone, persona, key, answer)
      const next = onboardingStage([...(memories || []), { key, value: answer }])
      if (next === 'done') return onboardingDoneText(stage === 'priority' ? answer : null)
      return nextOnboardingText(next, draftName)
    }
    // Nothing extractable yet: ask the current stage question so the
    // conversation keeps moving.
    return nextOnboardingText(stage, null)
  } catch (err) {
    console.warn('[onboarding] turn failed', err)
    return null
  }
}

/** Fire only on mail, calendar, brief, or schedule shaped asks and only when
 * neither gmail nor calendar is connected. */
export function suggestConnector(
  userText: string,
  connected: string[],
): { connectorId: 'gmail'; text: string } | null {
  const list = Array.isArray(connected) ? connected : []
  if (list.includes('gmail') || list.includes('calendar')) return null
  const fire = /\b(mail|e-?mail|emails?|inbox|gmail|calendar|schedule|schedul\w+|agenda|brief|debrief|day|meetings?|today|tomorrow)\b/i.test(
    String(userText || ''),
  )
  if (!fire) return null
  return {
    connectorId: 'gmail',
    text: `I can pull your calendar and mail into that. Connect Google and I am dangerous: ${CONNECTOR_SUGGEST_LINK}`,
  }
}
