import type { ChatMessage } from '../../src/agents/types'
import { gmiChat } from './gmi'
import { MAX_RAW, type MemoryFact } from './memory'

/**
 * Durable preferences stated in passing, captured without the model.
 *
 * "I always want aisle seats and I don't eat pork" must land in the memory
 * store even when the model call fails, when the turn falls back to a local
 * reply (source !== 'gmi' skipped maintenance entirely), or when extraction is
 * retried on a different provider. Only high-confidence categories are taken:
 * seats, diets/aversions, airlines, hotels, drinks. Anything less specific is
 * left to `extractFacts`, whose LLM pass can read the whole sentence.
 */
export function captureStatedPreferences(userText: string, now = Date.now()): MemoryFact[] {
  const text = userText.trim()
  if (!text) return []
  const facts: MemoryFact[] = []
  const push = (key: string, value: string) => {
    if (value && !facts.some((f) => f.key === key)) facts.push({ key, value, ts: now, lastSeen: now })
  }

  const seat = text.match(/\b(aisle|window)\s+seats?\b/i)
  if (seat && /\b(?:always|only|prefer|like|want|need|book|choose|get|pick)\b/i.test(text)) {
    push('seat_preference', `${seat[1]!.toLowerCase()} seat`)
  }

  // "I don't eat pork", "I never drink alcohol", "I don't do shellfish".
  // The trailing filler is stripped so the value is the food, not the politeness.
  const aversion = text.match(/\bi\s+(?:don'?t|do\s+not|never)\s+(?:eat|drink|order|have|do)\s+([^.,;!?\n]{2,40})/i)
  if (aversion) {
    const food = aversion[1]!
      .replace(/\s+/g, ' ')
      .replace(/\b(?:please|thanks|thank you|anywhere|at all|ever)\b/gi, '')
      .trim()
    if (food) {
      push('diet', `no ${food}`)
      push('hard_nos', `no ${food} anywhere`)
    }
  }

  // "no pork anywhere", "no shellfish for me"
  const noX = text.match(/\bno\s+([a-z][a-z\s-]{2,24}?)\s+(?:anywhere|at all|ever|for me|please|on my|in my)\b/i)
  if (noX) {
    const food = noX[1]!.trim()
    push('diet', `no ${food}`)
    push('hard_nos', `no ${food} anywhere`)
  }

  // "I always want/only book ..." with a recognizable category.
  const always = text.match(/\bi\s+(?:always|only)\s+(?:want|need|prefer|like|ask for|book|choose|get|pick)\s+([^.,;!?\n]{2,50})/i)
  if (always) {
    const phrase = always[1]!.trim()
    if (/\b(?:seat|aisle|window)\b/i.test(phrase)) {
      const side = phrase.match(/\b(aisle|window)\b/i)?.[1]
      if (side) push('seat_preference', `${side.toLowerCase()} seat`)
    } else if (/\b(?:vegetarian|vegan|halal|kosher|gluten[- ]?free|pescatarian)\b/i.test(phrase)) {
      push('diet', phrase.toLowerCase())
    } else if (/\b(?:airline|delta|united|american|southwest|jetblue|spirit|frontier|alaska)\b/i.test(phrase)) {
      push('flight_preference', phrase)
    } else if (/\b(?:hotel|room|bed|suite)\b/i.test(phrase)) {
      push('hotel_preference', phrase)
    } else if (/\b(?:coffee|tea|drink|wine|beer|espresso|cocktail)\b/i.test(phrase)) {
      push('drink_order', phrase)
    }
  }

  return facts
}

/** Ask the model to pull durable facts out of a turn. Returns an upsert-able list. */
export async function extractFacts(input: {
  userText: string
  reply: string
  existing: MemoryFact[]
  /** Ground-truth facts already known (dashboard context). Never overridden. */
  authoritative: string[]
}): Promise<MemoryFact[]> {
  const existingLines = input.existing.map((f) => `${f.key}: ${f.value}`).join('\n')
  const authLines =
    input.authoritative.length > 0
      ? input.authoritative
          .map((k) => k)
          .join('\n')
      : '(none)'
  const prompt = `Extract durable, factual things a user reveals about themselves (name, company, job, location, goals, dates, preferences, relationship details, dietary restrictions, travel preferences). Do NOT extract one-off small talk, emotions, or ephemera.

Also extract "bits": things that will still be funny or pointed three weeks from now. A bit is a running reference, a nickname they use, a team they suffer for, a recurring gripe, an ongoing project they joke about, or something they asked you to stop or start doing. Keys for these MUST start with "bit-" (for example bit-knicks, bit-pasta-tuesday, bit-nickname, bit-standup-gripe, bit-coffee-order). The value is short and concrete, and must be usable as a callback in a text. If nothing in the turn rises to that, extract no bits — a bit invented from small talk is worse than no bit.

Also extract tone_playfulness when the user asks how you should talk to them (more playful, funnier, keep it straight, no jokes, be serious). Value is exactly one of: playful, straight.

User: ${input.userText}
Assistant: ${input.reply}

Return a JSON object only, with no prose, in this exact shape:
{"facts":[{"key":"kebab_case_short_key","value":"short value"}, ...]}

Prefer durable keys when they fit: preferred_name, people, timezone, sister, sister_flight, partner, city, company, role_title, projects, standup_time, company_name, stage, weekly_focus, hard_nos, diet, seat_preference, flight_preference, this_weeks_decision, tone_playfulness.
Reuse an existing key if the fact already exists, otherwise invent a short kebab-case key. Omit anything not durable. Never expire names, people, timezone, bits, tone, or this week's decision.

GROUND TRUTH — do not re-extract anything already known here:
${authLines}

Existing facts:
${existingLines || '(none)'}`

  const now = Date.now()
  const deterministic = captureStatedPreferences(input.userText, now)

  let extracted: MemoryFact[] = []
  try {
    const raw = await gmiChat({ messages: [{ role: 'system', content: prompt }], temperature: 0, maxTokens: 400 })
    const parsed = JSON.parse(extractJson(raw)) as { facts?: Array<{ key?: string; value?: string }> }
    const authoritative = new Set(input.authoritative)
    extracted = (parsed.facts || [])
      .filter(
        (f) =>
          f &&
          typeof f.key === 'string' &&
          typeof f.value === 'string' &&
          !authoritative.has(f.key as string),
      )
      .map((f) => ({ key: f.key as string, value: f.value as string, ts: now, lastSeen: now }))
  } catch (err) {
    // The deterministic facts must survive a model/JSON failure; they are the
    // only capture path when the reply ran on the local fallback.
    console.warn('[memory] extractFacts model pass failed; keeping stated preferences:', err)
  }
  const combined = [...deterministic, ...extracted]
  const seen = new Set<string>()
  return combined.filter((f) => {
    if (seen.has(f.key)) return false
    seen.add(f.key)
    return true
  })
}

/** Fold everything older than MAX_RAW into a rolling summary. */
export async function summarizeOld(input: {
  history: ChatMessage[]
  priorSummary: string
}): Promise<string> {
  const lines = input.history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
  const prompt = `You are maintaining long-term memory for an AI assistant. Compress the older conversation into a concise rolling summary. Preserve facts, decisions, plans, open threads, and relationship details. Drop greetings and small talk. Aim for 3-6 sentences.

Prior summary:
${input.priorSummary || '(none)'}

Conversation to fold in:
${lines}

Return only the new summary text, no prose around it.`

  try {
    const summary = await gmiChat({ messages: [{ role: 'system', content: prompt }], temperature: 0, maxTokens: 300 })
    return summary.trim()
  } catch (err) {
    console.warn('[memory] summarizeOld failed:', err)
    return input.priorSummary
  }
}

function extractJson(text: string): string {
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) throw new Error('No JSON in reply')
  return text.slice(first, last + 1)
}

export { MAX_RAW }
