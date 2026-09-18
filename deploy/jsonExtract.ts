/* Pulling structured JSON out of a model's raw reply, and coercing the values
 * inside it.
 *
 * Adapted from affromero/flight-finder (MIT) — apps/web/src/lib/scraper/
 * extract-prices.ts — after reading how they survived the same models we run.
 * Their notes name the failures ours hit too: a greedy /\[[\s\S]*\]/ matches
 * from the first bracket to the last, so one stray bracket in the prose kills
 * the parse, and a price that arrives as "$1,189" or "1.189,50" compares as NaN
 * and drops every row.
 *
 * The rules here: strip reasoning blocks, scan every opening bracket, accept
 * the first balanced substring that actually parses, and prefer the one holding
 * objects (a prose or header array can come first and would otherwise win).
 */

/** Index of the bracket that closes the one at `start`, or -1. String- and
 * escape-aware, so a bracket inside a quoted string cannot close the span. */
export function matchingJsonEnd(text: string, start: number, open: string, close: string): number {
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close && --depth === 0) return i
  }
  return -1
}

function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json|javascript|js)?\s*/gi, (m) => (m.startsWith('```') ? '' : m))
    .replace(/```/g, '')
}

/** The first balanced JSON array in the reply, preferring one that holds
 * objects. Returns [] only when the model really returned an empty array. */
export function extractJsonArray(content: string): unknown[] | null {
  const text = stripReasoning(String(content || ''))
  let firstArray: unknown[] | null = null
  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    const end = matchingJsonEnd(text, start, '[', ']')
    if (end === -1) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    if (parsed.some((el) => typeof el === 'object' && el !== null)) return parsed
    if (firstArray === null) firstArray = parsed
  }
  return firstArray
}

/**
 * The first balanced JSON object in the reply. This is the shape our own
 * generators ask for ({"title":"…","code":"…"}), and they currently use a
 * greedy regex that a stray brace in the prose breaks.
 */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  const text = stripReasoning(String(content || ''))
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchingJsonEnd(text, start, '{', '}')
    if (end === -1) continue
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      continue
    }
  }
  return null
}

/** A price the model wrote as money, not a number: "$189", "1,189", "USD
 * 1,189.50", "1.189,50" (EU), "189pp". 0 when unusable. */
export function coerceMoney(value: unknown, max = 1_000_000): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value <= max ? value : 0
  if (typeof value !== 'string') return 0
  const raw = value.replace(/[^\d.,-]/g, '').trim()
  if (!raw) return 0
  const lastComma = raw.lastIndexOf(',')
  const lastDot = raw.lastIndexOf('.')
  let normalized = raw
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the LAST one is the decimal separator (EU writes 1.189,50).
    normalized = lastComma > lastDot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '')
  } else if (lastComma !== -1) {
    const after = raw.slice(lastComma + 1)
    // "1,189" is a thousands separator; "1,50" is a decimal comma.
    normalized = after.length === 3 ? raw.replace(/,/g, '') : raw.replace(',', '.')
  }
  const n = Number(normalized)
  return Number.isFinite(n) && n > 0 && n <= max ? n : 0
}

/** A whole number the model wrote loosely: "1 stop", "nonstop", "0". */
export function coerceCount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (/^(?:non-?stop|direct)$/.test(text)) return 0
  const digits = text.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

/** Read a field under any of its aliases; models rename things mid-answer. */
export function readField(entry: Record<string, unknown>, canonical: string, aliases: string[] = []): unknown {
  for (const key of [canonical, ...aliases]) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') return entry[key]
  }
  return undefined
}
