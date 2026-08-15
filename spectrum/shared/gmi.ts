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

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      // Cloudflare on gmi-serving blocks bare script UAs with 1010
      'User-Agent': 'HireAlpha/0.1 (spectrum-bot)',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 280,
      messages: options.messages,
    }),
  })

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
  const reply = (message?.content || message?.reasoning_content || '').trim()
  if (!reply) throw new Error('Empty GMI reply')
  return reply
}
