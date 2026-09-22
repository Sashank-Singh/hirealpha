import type { AgentDefinition, ChatMessage } from './types'
import { buildSystemPrompt, getAgent, type AgentId } from './index'

export interface RunAgentInput {
  agentId: AgentId
  messages: ChatMessage[]
  connectedApps?: string[]
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface RunAgentResult {
  reply: string
  source: 'model' | 'local'
  agentId: AgentId
}

/** Ordinary hellos, the shapes a first message actually takes. */
const GREETING_RE = /^(?:hey|hi|hello|yo|sup|howdy|good (?:morning|afternoon|evening)|morning|afternoon|evening|hola|what'?s up)\b/i

/** Local fallback when no API key is configured. Still follows agent behavior. */
export function runAgentLocally(agent: AgentDefinition, userText: string, opts: { firstName?: string } = {}): string {
  const lower = userText.toLowerCase().trim()
  const first = String(opts.firstName || '').trim().split(/\s+/)[0] || ''
  const hi = first ? `Hey ${first}` : 'Hey'

  /* A greeting is the one ask this path cannot drop.
   *
   * This is the reply a brand-new person sees when the model call is slow — live,
   * 2026-09-21: "Hey, Alpha!" timed out on the first attempt, the retry had no
   * wall left, and the fallback answered a hello with "I hit a quick snag thinking
   * through that. Can you say that once more?" A snag line for the easiest message
   * in the product, at first contact. There is nothing to fail at in a hello, so
   * it is answered the way a person answers one, using the name when the account
   * knows it. */
  if (GREETING_RE.test(lower)) {
    if (agent.id === 'coworker') return `${hi}. What do you need moving?`
    if (agent.id === 'cofounder') return `${hi}. What are we deciding?`
    return `${hi}. I'm Alpha, your friend in texts. What's on your mind?`
  }

  if (agent.id === 'friend') {
    if (/email|draft|stephen|interested/.test(lower)) {
      return `Here's a draft:

Subject: Re: [Role]

Hi Stephen,

Thanks for reaching out. I'm interested in the opportunity and would love to learn more about the role and next steps. Please let me know a few times that work for a conversation.

Best,
Sashank`
    }
    if (/spiral|anxious|nervous|scared|panic/.test(lower)) {
      return 'Okay. Name the fear in one line. Then one small move, not the whole day.'
    }
    if (/plan|tonight|weekend|hang|dinner/.test(lower)) {
      return 'What is the mood: somewhere quiet or somewhere loud. I will find the spot.'
    }
    if (/advice|should i|what do i/.test(lower)) {
      return 'Honest take. Peace, growth, or not regretting it?'
    }
    return "I'm unable to answer right now because my response service is unavailable."
  }

  if (agent.id === 'coworker') {
    if (/standup|stand up/.test(lower)) {
      return 'Yesterday / today / blocked. Send the raw notes. I’ll tighten, you paste.'
    }
    if (/meeting|agenda|prep|jordan|declined/.test(lower)) {
      return 'I can ask them for a new time and write it like you, not like a calendar. Want that?'
    }
    if (/follow.?up|remind/.test(lower)) {
      return 'Who owns it, what’s due, by when. I’ll draft it in your voice.'
    }
    return 'Bullets, a draft, or I move the calendar. Which.'
  }

  // cofounder
  if (/hire|vp|head of|ae|sales/.test(lower)) {
    return 'Leads or conversion. That answer decides the seat. Not the title.'
  }
  if (/fundrais|investor|raise|seed|series/.test(lower)) {
    return 'Why now, what changed, what breaks if you don’t. Three cold answers.'
  }
  if (/pivot|focus|kill|priority|agency|site|costume/.test(lower)) {
    return 'What ships this week that is the company, not a costume. Cut the rest.'
  }
  return 'What assumption is doing the most work. Say it so I can break it.'
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const agent = getAgent(input.agentId)
  const lastUser = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? ''

  if (!input.apiKey) {
    return {
      agentId: agent.id,
      source: 'local',
      reply: runAgentLocally(agent, lastUser),
    }
  }

  const system = buildSystemPrompt(agent, input.connectedApps)
  const model = input.model || 'gpt-4o-mini'
  const baseUrl = (input.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
      'User-Agent': 'HireAlpha/0.1 (vite-api)',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: agent.temperature,
      max_tokens: agent.maxTokens,
      messages: [{ role: 'system', content: system }, ...input.messages],
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Model error ${res.status}: ${errText.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string }
    }>
  }
  const message = data.choices?.[0]?.message
  const reply = (message?.content || message?.reasoning_content || '').trim()
  if (!reply) throw new Error('Empty model reply')

  return { agentId: agent.id, source: 'model', reply }
}
