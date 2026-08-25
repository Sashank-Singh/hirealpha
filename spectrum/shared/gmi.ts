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
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    // Cloudflare on gmi-serving blocks bare script UAs with 1010
    'User-Agent': 'HireAlpha/0.1 (spectrum-bot)',
    Accept: 'application/json',
  }
  const payload = (reasoningEffort: string) =>
    JSON.stringify({
      model,
      reasoning_effort: reasoningEffort,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 280,
      messages: options.messages,
    })

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // gmi-serving is load-balanced across backend nodes that disagree about
  // reasoning_effort: most accept 'none', some 400 demanding low|medium|high.
  // A plain retry can land on the same strict node, so the fallback switches
  // value; 429/5xx get one plain retry for transient capacity errors.
  let res = await fetch(url, { method: 'POST', headers, body: payload('none') })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    if (res.status === 400 && /reasoning_effort/i.test(errText)) {
      res = await fetch(url, { method: 'POST', headers, body: payload('low') })
    } else if (res.status === 429 || res.status >= 500) {
      await sleep(800)
      res = await fetch(url, { method: 'POST', headers, body: payload('none') })
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
  // Backends occasionally answer 200 with nothing in content; one clean retry
  // beats failing every caller on a transient empty.
  if (!reply) {
    await sleep(600)
    res = await fetch(url, { method: 'POST', headers, body: payload('none') })
    if (res.ok) {
      const retry = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      reply = (retry.choices?.[0]?.message?.content ?? '').trim()
    }
  }
  if (!reply) throw new Error('Empty GMI reply')
  return reply
}
