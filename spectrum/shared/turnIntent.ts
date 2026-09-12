/**
 * One model call decides what an incoming iMessage actually is, and extracts
 * the structured data it carries.
 *
 * This replaces the regex intent detectors ("looksLikeMoodReply",
 * "looksLikeSleepLog", "looksLikeNutritionLog", …) that used to gate every
 * write. Those were the root cause of a class of bugs that no amount of pattern
 * tuning fixes:
 *
 *   - "good morning" matched /^(?:i'?m)?\s*(good|…)\b/ and silently logged a
 *     mood with an invented 4/5 energy the user never gave.
 *   - "book me a table on opentable" needed a booking action, but the phrase
 *     only matched a place-recommendation pattern, so it returned directory
 *     links instead of staging the booking.
 *   - Every new phrasing ("slept badly", "grabbed a burrito", "feeling off")
 *     needed a new pattern, and each pattern risked a false positive on
 *     ordinary conversation.
 *
 * A model reads the message and returns the intent with its data. Nothing here
 * pattern-matches user language: the reply is parsed as JSON and validated
 * against explicit ranges, and anything the model cannot extract is simply left
 * out rather than guessed.
 */
import { gmiChat } from './gmi'

export type LogKind = 'mood' | 'sleep' | 'nutrition' | 'workout' | 'gratitude' | 'spend' | 'habit'

export type TurnIntent =
  /** Ordinary conversation. Nothing is written. */
  | { kind: 'chat' }
  /** The user reported something about themselves that is worth recording. */
  | {
      kind: 'log'
      logs: Array<{
        domain: LogKind
        /** Mood: the emoji the model judged, plus a 1-5 energy it read from the words. */
        mood?: { emoji: string; energy: number }
        /** Sleep: 24-hour HH:MM strings. */
        sleep?: { bedtime?: string; wake?: string; hours?: number }
        /** Nutrition: what was eaten, in the user's own words. */
        nutrition?: { description: string }
        /** Workout: exercise plus whatever set/rep/weight detail was stated. */
        workout?: { exercise: string; sets?: number; reps?: number; weight?: number }
        /** Gratitude: what they said they were grateful for. */
        gratitude?: { text: string }
        /** Spend: amount in dollars plus what it was for. */
        spend?: { amount: number; description: string; category?: string }
        /** Habit: which habit they completed, using a name they have used before. */
        habit?: { name: string }
      }>
    }
  /** The user wants something done in the world (book, order, send, find). */
  | {
      kind: 'request'
      request: {
        /** What they want, in one clause. */
        summary: string
        /** True when fulfilling it means touching an external website. */
        needsBrowser: boolean
        /** The site they named, when they named one. */
        site?: string
        /** True when the answer depends on current facts (news, prices, scores). */
        needsLookup: boolean
      }
    }
  /** Affirmation or cancellation of something Alpha just proposed. */
  | { kind: 'approval'; decision: 'affirm' | 'deny' }

export type ClassifyInput = {
  userText: string
  /** The last few turns, so "yes" and "that one" resolve against real context. */
  recentTurns?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** The proposal Alpha is currently waiting on, when there is one. */
  pendingQuestion?: string
}

const LOG_DOMAINS: LogKind[] = ['mood', 'sleep', 'nutrition', 'workout', 'gratitude', 'spend', 'habit']

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  const rounded = Math.round(n)
  if (rounded < min || rounded > max) return undefined
  return rounded
}

function timeOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim()) ? value.trim() : undefined
}

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

/** Coerce the model's JSON into the intent shape, dropping anything that fails
 * validation rather than forwarding a guess. */
export function normalizeTurnIntent(raw: unknown): TurnIntent {
  if (!raw || typeof raw !== 'object') return { kind: 'chat' }
  const data = raw as Record<string, unknown>
  const kind = data.kind

  if (kind === 'log') {
    const list = Array.isArray(data.logs) ? data.logs : []
    const logs: Extract<TurnIntent, { kind: 'log' }>['logs'] = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const log = entry as Record<string, unknown>
      const domain = log.domain
      if (typeof domain !== 'string' || !LOG_DOMAINS.includes(domain as LogKind)) continue
      const record: (typeof logs)[number] = { domain: domain as LogKind }

      const mood = log.mood as Record<string, unknown> | undefined
      if (domain === 'mood' && mood) {
        const emoji = shortText(mood.emoji, 8)
        const energy = clampInt(mood.energy, 1, 5)
        if (emoji && energy !== undefined) record.mood = { emoji, energy }
      }
      const sleep = log.sleep as Record<string, unknown> | undefined
      if (domain === 'sleep' && sleep) {
        const bedtime = timeOf(sleep.bedtime)
        const wake = timeOf(sleep.wake)
        const hours = clampInt(sleep.hours, 1, 24)
        if (bedtime || wake || hours !== undefined) {
          record.sleep = { ...(bedtime ? { bedtime } : {}), ...(wake ? { wake } : {}), ...(hours !== undefined ? { hours } : {}) }
        }
      }
      const nutrition = log.nutrition as Record<string, unknown> | undefined
      if (domain === 'nutrition' && nutrition) {
        const description = shortText(nutrition.description, 300)
        if (description) record.nutrition = { description }
      }
      const workout = log.workout as Record<string, unknown> | undefined
      if (domain === 'workout' && workout) {
        const exercise = shortText(workout.exercise, 80)
        if (exercise) {
          record.workout = {
            exercise,
            ...(clampInt(workout.sets, 1, 100) !== undefined ? { sets: clampInt(workout.sets, 1, 100) } : {}),
            ...(clampInt(workout.reps, 1, 1000) !== undefined ? { reps: clampInt(workout.reps, 1, 1000) } : {}),
            ...(clampInt(workout.weight, 1, 2000) !== undefined ? { weight: clampInt(workout.weight, 1, 2000) } : {}),
          }
        }
      }
      const gratitude = log.gratitude as Record<string, unknown> | undefined
      if (domain === 'gratitude' && gratitude) {
        const text = shortText(gratitude.text, 300)
        if (text) record.gratitude = { text }
      }
      const spend = log.spend as Record<string, unknown> | undefined
      if (domain === 'spend' && spend) {
        const amount = Number(spend.amount)
        const description = shortText(spend.description, 200)
        if (Number.isFinite(amount) && amount > 0 && amount < 100_000 && description) {
          record.spend = { amount: Math.round(amount * 100) / 100, description, ...(shortText(spend.category, 40) ? { category: shortText(spend.category, 40)! } : {}) }
        }
      }
      const habit = log.habit as Record<string, unknown> | undefined
      if (domain === 'habit' && habit) {
        const name = shortText(habit.name, 80)
        if (name) record.habit = { name }
      }

      // Only keep entries that carry their payload — a bare domain is a guess.
      const payloadKeys = LOG_DOMAINS.filter((key) => key in record)
      if (payloadKeys.length > 0) logs.push(record)
    }
    return logs.length ? { kind: 'log', logs } : { kind: 'chat' }
  }

  if (kind === 'request') {
    const request = data.request as Record<string, unknown> | undefined
    const summary = shortText(request?.summary, 300)
    if (!summary) return { kind: 'chat' }
    return {
      kind: 'request',
      request: {
        summary,
        needsBrowser: request?.needsBrowser === true,
        needsLookup: request?.needsLookup === true,
        ...(shortText(request?.site, 300) ? { site: shortText(request?.site, 300)! } : {}),
      },
    }
  }

  if (kind === 'approval') {
    const decision = data.decision
    if (decision === 'affirm' || decision === 'deny') return { kind: 'approval', decision }
  }

  return { kind: 'chat' }
}

const SYSTEM = `You read one iMessage to an assistant and return what it is, as JSON. You never pattern-match keywords; you read meaning.

Return exactly one of these shapes:

1. Ordinary conversation, a question, banter, a greeting, an acknowledgement:
{"kind":"chat"}

2. The user is reporting something about themselves that should be recorded. Include ONLY the domains actually present. Leave out every field they did not state — never fill a gap with a plausible value:
{"kind":"log","logs":[
  {"domain":"mood","mood":{"emoji":"🙂","energy":4}},
  {"domain":"sleep","sleep":{"bedtime":"23:30","wake":"06:45","hours":7.25}},
  {"domain":"nutrition","nutrition":{"description":"half a chipotle bowl with double chicken"}},
  {"domain":"workout","workout":{"exercise":"bench press","sets":3,"reps":8,"weight":135}},
  {"domain":"gratitude","gratitude":{"text":"my sister calling me"}},
  {"domain":"spend","spend":{"amount":42.5,"description":"gas","category":"transport"}},
  {"domain":"habit","habit":{"name":"reading"}}
]}

Rules for logs:
- A greeting or pleasantry is NOT a mood. "good morning", "good night", "ok thanks", "sounds good", "how are you" are all {"kind":"chat"}. A mood needs the user to actually say how they are or how they feel.
- NOTHING is logged unless it actually happened. Negations ("I didn't spend $80", "I haven't slept", "I skipped lunch") and hypotheticals, wishes, and future plans ("I wish I could sleep ten hours", "I should work out", "I'm going to spend $50") are all {"kind":"chat"}.
- A plain statement of a completed fact IS a log: "I slept 7 hours" (sleep), "spent $42 on gas" (spend), "I'm exhausted" / "feeling great" (mood), "did 3x8 bench at 135" (workout), "grateful for the call" (gratitude). Do not be timid: if they said it happened, log it.
- Talking ABOUT a tracker is not a log. "I'm tired of this app" is a mood about the app, not the user's state — that is {"kind":"chat"}. So is "brief me on the second email", which is a request for information, not a report.
- A message that reports a fact about someone else ("my sister slept badly") is {"kind":"chat"} — the log belongs to the user.
- energy is 1-5 and must be supported by their words. "exhausted" is 1, "fine" is 3, "great" is 5. If they only named a feeling with no intensity, infer from that word alone — do not invent a number for a message that carried no feeling at all.
- Times are 24-hour HH:MM. "slept 7 hours" carries hours but no clock times; report only hours.
- nutrition description is what they said they ate, in their words. Not a calorie guess.
- Only log a spend when a real amount was stated.
- Only log a habit when they say a specific habit is done. "done" alone is {"kind":"chat"} unless the assistant's previous message named the habit.

3. The user wants something done in the world, or asks for a fact that changes over time: book, reserve, order, buy, send, cancel, find, look up, check something, fill a form, sign up, call, research, or any question whose answer is not fixed (news, prices, scores, schedules, releases, availability, "how much is", "who won", "latest", "this week"):
{"kind":"request","request":{"summary":"one clause describing what they want","needsBrowser":true,"site":"https://www.opentable.com","needsLookup":false}}
- needsBrowser is true when fulfilling it means acting on a website (booking, ordering, filling a form, checking an account).
- needsLookup is true when the answer depends on current facts. "what's the latest news on X", "how much is X", "who won X", "when does X come out", and "is X available" are ALL requests with needsLookup true — never chat.
- site is the website they named, as an https URL, when they named one. Omit it when they did not.
- Only questions answerable from the conversation itself, from general knowledge that does not change, or from what the assistant already knows are {"kind":"chat"}. "explain compound interest" and "how are you" are chat; "what's the news" is a request.

4. The user is answering a proposal Alpha made (only when a pending question is shown below):
{"kind":"approval","decision":"affirm"}  or  {"kind":"approval","decision":"deny"}

Reply with JSON only. No prose, no code fences.`

/**
 * Classify one turn. Tuned for latency (short reply, low token cap) and it
 * fails to 'chat' — the safe default is to write nothing and answer normally.
 */
/**
 * Classify one turn. On any failure — provider error, unparseable reply — this
 * resolves to 'chat', the safe default: write nothing, answer normally.
 *
 * That collapse is correct for production and useless for verification, which
 * is why `classifyTurnStrict` exists: it throws on provider failure instead of
 * masking it, so a test can tell 'the model said chat' from 'the model was
 * never asked'. A missed classification that looked like a provider hiccup —
 * and vice versa — is otherwise undiagnosable.
 */
export async function classifyTurn(input: ClassifyInput): Promise<TurnIntent> {
  try {
    return await classifyTurnStrict(input)
  } catch {
    // A classifier outage must never write something wrong or block the reply.
    return { kind: 'chat' }
  }
}

export class ClassifierUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Intent classification could not reach the model: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ClassifierUnavailableError'
  }
}

export async function classifyTurnStrict(input: ClassifyInput): Promise<TurnIntent> {
  const text = input.userText.trim()
  if (!text) return { kind: 'chat' }
  const context = (input.recentTurns ?? []).slice(-6)
    .map((turn) => `${turn.role === 'user' ? 'Them' : 'Assistant'}: ${turn.content.slice(0, 300)}`)
    .join('\n')
  // A transport failure IS "could not reach the model", so it is wrapped here.
  // Leaving it raw made the two failure modes indistinguishable to callers: a
  // rate-limited classifier looked exactly like a message the model had read
  // wrong, and there was no way to tell a retry from a real miss.
  // 25s with one retry: the classifier shares the provider with the turn
  // itself and a reasoning model's first token can consume most of a 12s
  // budget; a timed-out classifier used to strip intent from the whole turn.
  const attempt = () =>
    gmiChat({
      temperature: 0,
      maxTokens: 200,
      timeoutMs: 25_000,
      messages: [
        { role: 'system', content: SYSTEM },
        ...(context ? [{ role: 'user' as const, content: `Recent turns:\n${context}` }] : []),
        ...(input.pendingQuestion
          ? [{ role: 'user' as const, content: `Alpha is currently waiting on this, so a short reply may be an answer to it:\n${input.pendingQuestion.slice(0, 300)}` }]
          : []),
        { role: 'user', content: text },
      ],
    })
  let raw: string
  try {
    try {
      raw = await attempt()
    } catch (first) {
      if (!/timed out|timeout|aborted/i.test(String((first as Error)?.message || first))) throw first
      await new Promise((r) => setTimeout(r, 500))
      raw = await attempt()
    }
  } catch (error) {
    throw new ClassifierUnavailableError(error)
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) throw new ClassifierUnavailableError(`unparseable reply: ${raw.slice(0, 120)}`)
  return normalizeTurnIntent(JSON.parse(raw.slice(start, end + 1)))
}

/** All log payloads of a given domain, for callers that handle one at a time. */
export function logsOf<K extends LogKind>(intent: TurnIntent, domain: K): Array<Extract<TurnIntent, { kind: 'log' }>['logs'][number]> {
  if (intent.kind !== 'log') return []
  return intent.logs.filter((log) => log.domain === domain)
}
