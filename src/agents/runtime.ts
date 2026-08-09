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

/** Local fallback when no API key is configured. Still follows agent behavior. */
export function runAgentLocally(agent: AgentDefinition, userText: string): string {
  const lower = userText.toLowerCase()

  if (agent.id === 'friend') {
    if (/spiral|anxious|nervous|scared|panic/.test(lower)) {
      return 'Okay. Name the fear in one line. Then we pick one small move, not the whole day.'
    }
    if (/plan|tonight|weekend|hang/.test(lower)) {
      return 'I’m in. What energy do you want: quiet, social, or somewhere in between?'
    }
    if (/advice|should i|what do i/.test(lower)) {
      return 'I’ll give you the honest take. What are you optimizing for: peace, growth, or not regretting it?'
    }
    return 'I’m here. Tell me the real part, not the polished version.'
  }

  if (agent.id === 'coworker') {
    if (/standup|stand up/.test(lower)) {
      return 'Yesterday: [fill]. Today: [fill]. Blocked: [fill]. Send me the raw notes and I’ll tighten it.'
    }
    if (/meeting|agenda|prep/.test(lower)) {
      return 'Goal, decisions needed, and pre-reads. Want a 5-line agenda draft?'
    }
    if (/follow.?up|remind/.test(lower)) {
      return 'I can draft the follow-up. Who owns it, what’s due, and by when?'
    }
    return 'Got it. Want bullets, a draft, or a blocker list first?'
  }

  // cofounder
  if (/hire|vp|head of|ae|sales/.test(lower)) {
    return 'Before the hire: is the bottleneck leads or conversion? That answer decides the seat.'
  }
  if (/fundrais|investor|raise|seed|series/.test(lower)) {
    return 'Why now, what changed, and what breaks if you don’t raise? Give me those three cold.'
  }
  if (/pivot|focus|kill|priority/.test(lower)) {
    return 'What ships this week that moves the company, not your anxiety? Cut the rest.'
  }
  return 'Pushback first: what assumption in that plan is doing the most work?'
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
