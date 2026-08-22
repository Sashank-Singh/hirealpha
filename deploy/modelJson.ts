/* ---- Reading JSON back out of a model reply ----
 * The estimator asks for JSON only and usually gets it. The failures are not
 * random, and a first-brace-to-last-brace slice loses every one of them: a
 * reasoning model can leave `content` empty and put the answer in
 * `reasoning_content`, leak a <think> block whose draft braces sit in front of
 * the real object, or run out of tokens mid-object. Each case is handled here so
 * it can be tested without a model, and every repair goes back through
 * JSON.parse, so a bad guess fails instead of inventing a number.
 */

export type ModelMessage = { content?: string | null; reasoning_content?: string | null } | null | undefined

const THINK_PAIR = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi
const THINK_CLOSE = /<\/(?:think|thinking|reasoning)>/i
const THINK_OPEN = /<(?:think|thinking|reasoning)>/i

/** Drop the model's scratchpad so its drafts cannot shadow the answer. */
export function stripReasoning(text: string): string {
  let out = String(text || '').replace(THINK_PAIR, ' ')
  const close = out.match(THINK_CLOSE)
  // An orphan close tag means the opener was trimmed upstream: keep what follows.
  if (close?.index !== undefined) out = out.slice(close.index + close[0].length)
  const open = out.match(THINK_OPEN)
  // An orphan open tag means the reply was cut mid-thought: keep what precedes.
  if (open?.index !== undefined) out = out.slice(0, open.index)
  return out.trim()
}

/**
 * What the model actually said. `content` first, then the scratchpad — a
 * reasoning-only reply has an empty `content`, and reading just that field turns
 * a good answer into "no reply".
 */
export function modelReplyText(message: ModelMessage): string {
  const content = String(message?.content ?? '')
  const answer = stripReasoning(content)
  if (answer) return answer
  const scratch = String(message?.reasoning_content ?? '').trim()
  if (scratch) return scratch
  // All of `content` was scratchpad. A draft still beats an empty string.
  return content.trim()
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function tryParse(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return asObject(JSON.parse(trimmed))
  } catch {
    return null
  }
}

/** Balanced `{…}` spans — string- and escape-aware — plus the tail of an unclosed one. */
function objectSpans(text: string): { closed: string[]; open: string; depth: number; inString: boolean } {
  const closed: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        closed.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return { closed, open: depth > 0 && start >= 0 ? text.slice(start) : '', depth, inString }
}

/**
 * A reply cut off mid-object still holds the fields it managed to print. Close
 * the open string and braces; if that will not parse, drop back to each comma
 * and try again. There are only a handful of commas in these payloads, and
 * JSON.parse is the gate on every attempt.
 */
function repairTruncated(
  frag: string,
  depth: number,
  inString: boolean,
  wantKeys: string[],
): Record<string, unknown> | null {
  const close = '}'.repeat(Math.max(depth, 1))
  const attempts = [inString ? `${frag}"${close}` : `${frag}${close}`]
  for (let i = frag.length - 1; i > 0; i--) if (frag[i] === ',') attempts.push(`${frag.slice(0, i)}${close}`)
  for (const attempt of attempts) {
    const hit = tryParse(attempt)
    if (hit && wantKeys.every((k) => k in hit)) return hit
  }
  return null
}

/**
 * The JSON object a reply meant to send, through fences, prose, a leaked
 * scratchpad, or a cut-off ending.
 *
 * `wantKeys` is how a caller says which object is the answer: only objects
 * carrying all of those keys are eligible, so a draft or an `{"error":…}` shrug
 * is rejected rather than read as an estimate of zero. The last eligible object
 * wins, because a model that prints twice prints the answer second.
 *
 * The scan is for objects, not for the top-level value, so a reply that wrapped
 * the answer in an array still yields the object inside it.
 */
export function extractJsonObject(text: string, wantKeys: string[] = []): Record<string, unknown> | null {
  const cleaned = stripReasoning(text)
  if (!cleaned) return null
  const fenced = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]!)
  const spans = objectSpans(cleaned)
  const eligible = [...fenced, cleaned, ...spans.closed]
    .map(tryParse)
    .filter((o): o is Record<string, unknown> => !!o && wantKeys.every((k) => k in o))
  return eligible.at(-1) ?? (spans.open ? repairTruncated(spans.open, spans.depth, spans.inString, wantKeys) : null)
}

/**
 * Numbers by label, for a reply no parser could rescue: `"calories": 640`,
 * `**protein** — 32 g`, `carbs = 71`. Bounded to a short run of non-digits after
 * the label so it cannot reach past its own value into the next number.
 */
export function extractNumericFields(text: string, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  const cleaned = stripReasoning(text) || String(text || '')
  for (const key of keys) {
    const safe = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = cleaned.match(new RegExp(`${safe}\\D{0,12}(-?\\d+(?:\\.\\d+)?)`, 'i'))
    const n = m ? Number(m[1]) : Number.NaN
    if (Number.isFinite(n)) out[key] = n
  }
  return out
}
