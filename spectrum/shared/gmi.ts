export interface GmiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Hidden reasoning tokens the model may spend before it writes the visible
 * answer. Sized from a measured gemini-3.7-flash fast reply (156 reasoning
 * tokens) plus headroom for longer chains. */
export const REASONING_TOKEN_HEADROOM = 400

/** Time a retry must leave for the request itself. A backoff that consumes the
 * whole budget turns a transient 429 into a failed turn. */
const MIN_REQUEST_MS = 3_000

/** Minimum spacing between provider requests, process-wide.
 *
 * One conversational turn fans out several model calls (intent, tool picks,
 * the answer) and they land in the same instant. Measured against the live
 * provider with this account's key: bursts are refused after roughly three
 * calls, while steady traffic at one request per second runs clean over a
 * ten-call sample.
 *
 * The spacing is paid ONLY after a refusal, never on the happy path. Applying
 * it to every call cost a second each and made a four-call turn take fourteen
 * seconds; a caller who is not being refused should never wait for a
 * rate-limit that is not happening. */
const SPACING_AFTER_REFUSAL_MS = 1_000
/** How long a refusal keeps the throttle engaged. */
const REFUSAL_COOLDOWN_MS = 8_000
let providerQueue: Promise<unknown> = Promise.resolve()
let lastProviderCallAt = 0
let refusedUntil = 0

/** Called when the provider refuses a request, arming the throttle. */
function noteRefusal(): void {
  refusedUntil = Date.now() + REFUSAL_COOLDOWN_MS
}

function withProviderSlot<T>(run: () => Promise<T>): Promise<T> {
  const throttled = Date.now() < refusedUntil
  if (!throttled) {
    // No known pressure: go now, but keep the queue honest so two in-flight
    // calls cannot stampede after a refusal.
    return run()
  }
  const scheduled = providerQueue.then(async () => {
    const wait = SPACING_AFTER_REFUSAL_MS - (Date.now() - lastProviderCallAt)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastProviderCallAt = Date.now()
    return run()
  })
  // Keep the chain alive even when a call rejects, so one failure cannot wedge
  // every later request.
  providerQueue = scheduled.catch(() => undefined)
  return scheduled
}

export interface GmiChatOptions {
  messages: GmiChatMessage[]
  temperature?: number
  maxTokens?: number
  model?: string
  apiKey?: string
  baseUrl?: string
  /** Total deadline across the initial request and any retries. */
  timeoutMs?: number
}

export async function gmiChat(options: GmiChatOptions): Promise<string> {
  const apiKey =
    options.apiKey ||
    process.env.GMI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.HIREALPHA_API_KEY

  if (!apiKey) {
    throw new Error('Missing GMI_API_KEY (or OPENAI_API_KEY) in env')
  }

  const baseUrl = (
    options.baseUrl ||
    process.env.GMI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    'https://api.gmi-serving.com/v1'
  ).replace(/\/$/, '')

  const model =
    options.model ||
    process.env.GMI_MODEL ||
    process.env.HIREALPHA_MODEL ||
    'Qwen/Qwen3.8-Flash'

  const url = `${baseUrl}/chat/completions`
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    // Cloudflare on gmi-serving blocks bare script UAs with 1010
    'User-Agent': 'HireAlpha/0.1 (spectrum-bot)',
    Accept: 'application/json',
  }
  const payload = (reasoningEffort?: string) => {
    const body: Record<string, unknown> = {
      model,
      temperature: options.temperature ?? 0.7,
      messages: options.messages,
    }
    if (options.maxTokens) {
      // Reasoning models (gemini-3.7-flash and thinking modes generally) spend
      // a large share of max_tokens on hidden reasoning — measured ~150-170 of
      // a 220 budget — which truncated visible replies mid-sentence
      // ("Morning! Though it"). maxTokens is the ceiling on what the user
      // reads, so the reasoning share is granted on top of it.
      body.max_tokens = options.maxTokens + REASONING_TOKEN_HEADROOM
    }
    if (reasoningEffort && reasoningEffort !== 'omit') {
      body.reasoning_effort = reasoningEffort
    }
    return JSON.stringify(body)
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // Some endpoints accept 'low' | 'medium' | 'high', some accept 'none', and
  // standard OpenAI-compatible endpoints reject reasoning_effort completely.
  //
  // Rate limiting and transient failures are retried inside the caller's
  // deadline. The provider signals rate limits BOTH ways — as 429 and as 400
  // with {"error":"Rate limit exceeded"} — so the status alone is not a
  // reliable test; the body is inspected when the status is not a success.
  //
  // The limit is per-second-burst, not a slow drip: a single turn's calls
  // (classifier, tool picks, the answer) arrive together and the tail of them
  // gets refused. Retrying immediately with a short wait is what clears it —
  // but every retry is itself a request, so the ladder is deliberately short.
  // A four-attempt ladder turned one refusal into four more requests and made
  // the burst worse (measured: 21 refusals across two turns).
  const attemptBudgetMs = options.timeoutMs ?? 30_000
  const startedAt = Date.now()
  const retryable = async (response: Response): Promise<boolean> => {
    if (response.ok) return false
    if (response.status === 429 || response.status >= 500) return true
    if (response.status !== 400) return false
    const body = await response.clone().text().catch(() => '')
    return /rate.?limit|too many requests|overloaded|try again/i.test(body)
  }
  const call = () => withProviderSlot(() =>
    fetch(url, { method: 'POST', headers, body: payload('omit'), signal }))
  let res = await call()
  // One retry, and only when the deadline can still fit it. The retry lands in
  // the provider's next window; the throttle it arms keeps every later call in
  // this turn spaced until the pressure clears.
  if (await retryable(res)) {
    noteRefusal()
    if (Date.now() - startedAt + 1_100 + MIN_REQUEST_MS <= attemptBudgetMs) {
      await sleep(1_100)
      res = await call()
    }
  }
  if (!res.ok && res.status === 400) {
    const errText = await res.clone().text().catch(() => '')
    if (/reasoning_effort/i.test(errText)) {
      // If endpoint strictly requires reasoning_effort (e.g. low/medium/high)
      const fallbackEffort = /'low'/i.test(errText) || /must be one of/i.test(errText) ? 'low' : 'none'
      res = await fetch(url, { method: 'POST', headers, body: payload(fallbackEffort), signal })
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`GMI error ${res.status}: ${errText.slice(0, 240)}`)
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string }
    }>
  }
  const message = data.choices?.[0]?.message
  let reply = (message?.content ?? '').trim()
  // DeepSeek reasoning models can inline their chain-of-thought in content.
  // It must never reach a user: strip every <think>…</think> block.
  reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  reply = reply.replace(/^\s*<\/?think>\s*/i, '').trim()
  // Some completions begin with orphaned instruction fragments before the real
  // answer ("You are a helpful assistant. </think>I can't..."). Cut everything
  // before the first conversational sentence instead of shipping the junk.
  const convStart = reply.search(/\b(?:i (?:can|cannot|can't|'ll|will|'m|found|set|think)|hey|hi\b|of course|got it|on it|sure|done|quick|heads up|nothing|want me to|here)/i)
  if (convStart > 0 && /^(?:[A-Z][a-z]+\s){0,3}(?:do not|never|no |use |only if|update_|send_|search_|open_|lookup_)|^\S+_\w+:\s*input\s*\{/i.test(reply.slice(0, 120))) {
    reply = reply.slice(convStart).trim()
  }
  // Backends occasionally answer 200 with nothing in content; one clean retry
  // beats failing every caller on a transient empty.
  if (!reply) {
    await sleep(600)
    res = await fetch(url, { method: 'POST', headers, body: payload('none'), signal })
    if (res.ok) {
      const retry = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      reply = (retry.choices?.[0]?.message?.content ?? '').trim()
    }
  }
  // Degenerate completion: the model echoes its own instructions ("No markdown.
  // No emojis...", "If the user asks for a comparison...") instead of answering.
  // It looks like a 200 and reads like garbage. Detect and retry once, then
  // throw so callers use their fallback instead of texting prompt fragments.
  // Structural signature: several imperative spec fragments + tool-schema
  // shapes + zero conversational voice in the whole reply.
  const imperative = (reply.match(/\b(?:do not|never|no |use |only if|must)\b/gi) || []).length
  const schemaish = /\b\w+_\w+\b:\s*(?:input\s*)?\{/.test(reply) || /\binput\s*\{/.test(reply)
  const conversational = /\b(?:i (?:can|'ll|will|found|set|think|'m)|you(?:'r| are)|let me|want me to|here(?:'s| is))\b/i.test(reply.slice(0, 300))
  const looksLikeEcho =
    ((/^(?:no markdown|no emojis|if the user asks|you are alpha|never |always |do not )/i.test(reply) && imperative >= 4) ||
      (schemaish && imperative >= 3)) &&
    reply.split(/\s+/).length > 24 &&
    !conversational
  if (looksLikeEcho) {
    await sleep(800)
    res = await fetch(url, { method: 'POST', headers, body: payload('none'), signal })
    if (res.ok) {
      const retry = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const second = (retry.choices?.[0]?.message?.content ?? '').trim()
        .replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      if (second && !/^(?:no markdown|no emojis|if the user asks)/i.test(second)) reply = second
    }
    if (/^(?:no markdown|no emojis|if the user asks)/i.test(reply)) throw new Error('GMI echoed instructions')
  }
  if (!reply) throw new Error('Empty GMI reply')
  return reply
}
