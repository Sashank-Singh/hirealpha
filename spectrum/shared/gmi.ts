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
type ProviderThrottle = { queue: Promise<unknown>; lastCallAt: number; refusedUntil: number }
const providerThrottles = new Map<string, ProviderThrottle>()

function providerThrottle(baseUrl: string): ProviderThrottle {
  const origin = new URL(baseUrl).origin
  let state = providerThrottles.get(origin)
  if (!state) {
    state = { queue: Promise.resolve(), lastCallAt: 0, refusedUntil: 0 }
    providerThrottles.set(origin, state)
  }
  return state
}

/** Called when the provider refuses a request, arming the throttle. */
function noteRefusal(state: ProviderThrottle): void {
  state.refusedUntil = Date.now() + REFUSAL_COOLDOWN_MS
}

function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const aborted = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

function withProviderSlot<T>(state: ProviderThrottle, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const throttled = Date.now() < state.refusedUntil
  if (!throttled) {
    // No known pressure: go now, but keep the queue honest so two in-flight
    // calls cannot stampede after a refusal.
    return run()
  }
  const scheduled = state.queue.then(async () => {
    signal.throwIfAborted()
    const wait = SPACING_AFTER_REFUSAL_MS - (Date.now() - state.lastCallAt)
    if (wait > 0) await abortableDelay(wait, signal)
    signal.throwIfAborted()
    state.lastCallAt = Date.now()
    return run()
  })
  // Keep the chain alive even when a call rejects, so one failure cannot wedge
  // every later request.
  state.queue = scheduled.catch(() => undefined)
  // Expire while waiting behind another request, then skip the stale slot
  // when the queue reaches it. Never issue a fetch after its deadline.
  return withinSignal(scheduled, signal)
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
  /**
   * Hidden-thinking budget. Unset keeps the provider default, which for this
   * model means a long private chain of thought before the visible answer:
   * measured on the conversational path at 10.4s and 12.3s (the second one
   * spending 2661 reasoning characters and returning an EMPTY reply), against
   * 3.3-3.5s at 'low'. Latency-sensitive calls pass 'low'; a judgement call
   * that benefits from thinking leaves it alone.
   */
  reasoningEffort?: 'low' | 'none' | 'omit'
}

/**
 * Provider failover across models on the SAME key. GMI serves many models
 * from different capacity pools: when the configured model stalls (timeout,
 * aborted fetch) or its pool refuses (5xx after the in-call retry) or returns
 * an empty/echoed completion, a single retry on GMI_MODEL_FALLBACK often
 * succeeds where the first model kept failing all night. Same endpoint, same
 * key — no new provider needed.
 */
export async function gmiChat(options: GmiChatOptions): Promise<string> {
  const originalBudget = options.timeoutMs ?? 30_000
  // Opt-in independent service, with its own credentials and model. Explicit
  // endpoint callers (probes, image/workshop integrations) retain their route.
  const backup = !options.apiKey && !options.baseUrl ? configuredBackup() : undefined
  const useBackup = backup && originalBudget >= 2 * MIN_REQUEST_MS
  // Reserve useful time for the independent service; a timeout that consumes
  // the entire caller deadline cannot fail over within that deadline.
  const primaryBudget = useBackup ? Math.min(6_000, Math.floor(originalBudget / 2)) : originalBudget
  const startedAt = Date.now()
  try {
    return await gmiChatOnce({ ...options, timeoutMs: primaryBudget })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const worthFailover =
      /timed out|timeout|aborted|fetch failed|failed to fetch|connection|socket|network|ECONNRESET|GMI error 5\d\d|GMI error 429|Rate limit exceeded|Empty GMI reply|echoed instructions/i.test(msg)
    const primary = options.model || process.env.GMI_MODEL || process.env.HIREALPHA_MODEL || 'zai-org/GLM-5.3-Flash'
    const fallback = process.env.GMI_MODEL_FALLBACK || 'zai-org/GLM-5.3-Flash'
    const endpoint = options.baseUrl || process.env.GMI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.gmi-serving.com/v1'
    const remainingMs = originalBudget - (Date.now() - startedAt)
    if (useBackup && worthFailover && remainingMs > 0) {
      console.warn(`[model] primary failed; recovering through ${new URL(backup.baseUrl).hostname}`)
      return await gmiChatOnce({ ...options, ...backup, timeoutMs: remainingMs })
    }
    // Only real turn-sized budgets fail over: a tiny probe deadline (tests,
    // health checks) must stay a fast rejection, never a second attempt.
    if (new URL(endpoint).hostname === 'openrouter.ai' || !worthFailover || fallback === primary || originalBudget < 6_000 || remainingMs < MIN_REQUEST_MS) throw err
    console.warn(`[gmi] ${primary} failed (${msg.slice(0, 80)}); failing over to ${fallback}`)
    // The caller owns recovery after this deadline. Resetting it here stacks
    // model failover beneath chat recovery and can double the user's wait.
    return await gmiChatOnce({ ...options, model: fallback, timeoutMs: remainingMs })
  }
}

function configuredBackup(): { apiKey: string; baseUrl: string; model: string } | undefined {
  const apiKey = process.env.HIREALPHA_MODEL_FALLBACK_API_KEY?.trim()
  const baseUrl = process.env.HIREALPHA_MODEL_FALLBACK_BASE_URL?.trim()
  const model = process.env.HIREALPHA_MODEL_FALLBACK_MODEL?.trim()
  if (!apiKey && !baseUrl && !model) return undefined
  if (!apiKey || !baseUrl || !model) throw new Error('Independent model fallback requires API_KEY, BASE_URL and MODEL')
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Independent model fallback requires an HTTPS endpoint without URL credentials')
  return { apiKey, baseUrl, model }
}

async function gmiChatOnce(options: GmiChatOptions): Promise<string> {
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
    'zai-org/GLM-5.3-Flash'

  const url = `${baseUrl}/chat/completions`
  const openRouter = new URL(baseUrl).hostname === 'openrouter.ai'
  const throttle = providerThrottle(baseUrl)
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  // A long-lived process reuses keep-alive sockets; when the provider closes an
  // idle one, the next request can hang on the dead socket until the abort
  // fires ("The operation timed out."). A fresh connection per call removes
  // that stall class at the cost of one handshake.
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    // Cloudflare on gmi-serving blocks bare script UAs with 1010
    'User-Agent': 'HireAlpha/0.1 (spectrum-bot)',
    Accept: 'application/json',
    // Never reuse a possibly-dead keep-alive socket (see the timeout note).
    Connection: 'close',
  }
  // GLM's backend 400s on system-only message arrays ("System-only messages
  // are not supported by this backend"). Several helpers legitimately send a
  // single system prompt, so normalize once here rather than at every call
  // site: append a neutral user turn when none exists.
  const messages =
    options.messages.length > 0 && options.messages.every((m) => m.role === 'system')
      ? [...options.messages, { role: 'user' as const, content: 'Proceed.' }]
      : options.messages
  const payload = (reasoningEffort?: string) => {
    const body: Record<string, unknown> = {
      // Same exact model, using the host's model identifier. Existing callers
      // pin the GMI/Hugging Face identifier, including workshop generation.
      model: openRouter && model === 'zai-org/GLM-5.3-Flash' ? 'z-ai/glm-5.3-flash' : model,
      temperature: options.temperature ?? 0.7,
      messages,
    }
    if (openRouter) {
      // Keep GLM fixed while allowing healthy hosts to replace a failed host.
      // A recovery request must not route straight back to GMI's outage.
      body.provider = { sort: 'latency', allow_fallbacks: true, ignore: ['gmicloud'] }
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
      if (openRouter) body.reasoning = { effort: reasoningEffort }
      else body.reasoning_effort = reasoningEffort
    }
    return JSON.stringify(body)
  }

  const sleep = (ms: number) => abortableDelay(ms, signal)

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
  const call = (effort: string) => withProviderSlot(throttle, signal, () =>
    fetch(url, { method: 'POST', headers, body: payload(effort), signal }))
  const primaryEffort = options.reasoningEffort ?? 'omit'
  let res = await call(primaryEffort)
  // One retry, and only when the deadline can still fit it. The retry lands in
  // the provider's next window; the throttle it arms keeps every later call in
  // this turn spaced until the pressure clears.
  if (await retryable(res)) {
    noteRefusal(throttle)
    if (Date.now() - startedAt + 1_100 + MIN_REQUEST_MS <= attemptBudgetMs) {
      await sleep(1_100)
      res = await call(primaryEffort)
    }
  }
  if (!res.ok && res.status === 400) {
    const errText = await res.clone().text().catch(() => '')
    if (/reasoning_effort/i.test(errText)) {
      // Endpoints disagree about this field: some require low/medium/high,
      // some accept only 'none', some reject it outright. Walk the ladder from
      // what the error asks for down to sending nothing at all, so a primary
      // effort the backend dislikes degrades into the old behaviour instead of
      // failing the turn.
      const strict = /'low'/i.test(errText) || /must be one of/i.test(errText)
      for (const effort of strict ? ['low', 'omit'] : ['none', 'omit']) {
        res = await call(effort)
        if (res.ok) break
      }
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
  // beats failing every caller on a transient empty. The retry has to change
  // something, though: an empty content field is usually the whole token
  // ceiling spent on hidden reasoning (measured: 4383 reasoning tokens, 0
  // characters of answer), and 'none' is rejected outright by some backends —
  // so it walks the ladder instead of repeating the request that just failed.
  if (!reply) {
    for (const effort of ['low', 'omit', 'none']) {
      await sleep(600)
      res = await call(effort)
      if (!res.ok) continue
      const retry = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      reply = (retry.choices?.[0]?.message?.content ?? '').trim()
      reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      if (reply) break
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
  // A JSON payload is an answer, never an echo — but a generated program
  // contains `word_word: {` shapes and imperative words in its own code, so the
  // heuristic below can fire on it and silently regenerate a build that was
  // already correct (measured: one workshop call took 84s for exactly this).
  const looksLikeJson = /^[{[]/.test(reply.trim())
  const looksLikeEcho =
    !looksLikeJson &&
    ((/^(?:no markdown|no emojis|if the user asks|you are alpha|never |always |do not )/i.test(reply) && imperative >= 4) ||
      (schemaish && imperative >= 3)) &&
    reply.split(/\s+/).length > 24 &&
    !conversational
  if (looksLikeEcho) {
    await sleep(800)
    res = await call('none')
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
