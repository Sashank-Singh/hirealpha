import type { ChatMessage } from '../../src/agents/types'
import { gmiChat } from './gmi'
import { MAX_RAW, type MemoryFact } from './memory'

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
  const prompt = `Extract durable, factual things a user reveals about themselves (name, company, job, location, goals, dates, preferences, relationship details). Do NOT extract one-off small talk, emotions, or ephemera.

User: ${input.userText}
Assistant: ${input.reply}

Return a JSON object only, with no prose, in this exact shape:
{"facts":[{"key":"kebab_case_short_key","value":"short value"}, ...]}

Prefer durable keys when they fit: preferred_name, people, timezone, sister, sister_flight, partner, city, company, role_title, projects, standup_time, company_name, stage, weekly_focus, hard_nos, this_weeks_decision.
Reuse an existing key if the fact already exists, otherwise invent a short kebab-case key. Omit anything not durable. Never expire names, people, timezone, or this week's decision.

GROUND TRUTH — do not re-extract anything already known here:
${authLines}

Existing facts:
${existingLines || '(none)'}`

  try {
    const raw = await gmiChat({ messages: [{ role: 'system', content: prompt }], temperature: 0, maxTokens: 400 })
    const parsed = JSON.parse(extractJson(raw)) as { facts?: Array<{ key?: string; value?: string }> }
    const now = Date.now()
    const authoritative = new Set(input.authoritative)
    return (parsed.facts || [])
      .filter(
        (f) =>
          f &&
          typeof f.key === 'string' &&
          typeof f.value === 'string' &&
          !authoritative.has(f.key as string),
      )
      .map((f) => ({ key: f.key as string, value: f.value as string, ts: now, lastSeen: now }))
  } catch (err) {
    console.warn('[memory] extractFacts failed:', err)
    return []
  }
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
