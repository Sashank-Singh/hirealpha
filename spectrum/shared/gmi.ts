export interface GmiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
    'deepseek-ai/DeepSeek-V4-Flash-0731'

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
      max_tokens: options.maxTokens ?? 280,
      messages: options.messages,
    }
    if (reasoningEffort && reasoningEffort !== 'omit') {
      body.reasoning_effort = reasoningEffort
    }
    return JSON.stringify(body)
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // Some endpoints accept 'low' | 'medium' | 'high', some accept 'none', and
  // standard OpenAI-compatible endpoints reject reasoning_effort completely.
  let res = await fetch(url, { method: 'POST', headers, body: payload('omit'), signal })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    if (res.status === 400 && /reasoning_effort/i.test(errText)) {
      // If endpoint strictly requires reasoning_effort (e.g. low/medium/high)
      const fallbackEffort = /'low'/i.test(errText) || /must be one of/i.test(errText) ? 'low' : 'none'
      res = await fetch(url, { method: 'POST', headers, body: payload(fallbackEffort), signal })
    } else if (res.status === 429 || res.status >= 500) {
      await sleep(800)
      res = await fetch(url, { method: 'POST', headers, body: payload('omit'), signal })
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
