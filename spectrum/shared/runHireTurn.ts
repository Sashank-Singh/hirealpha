import {
  getAgent,
  buildSystemPrompt,
  type AgentId,
} from '../../src/agents'
import { runAgentLocally } from '../../src/agents/runtime'
import { skillsPromptBlock } from './skills'
import { gmiChat } from './gmi'
import { appendThread, loadThread } from './memory'

export function splitBubbles(text: string): string[] {
  const cleaned = text.replace(/\r/g, '').trim()
  if (!cleaned) return ['…']
  const parts = cleaned
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length <= 1) {
    if (cleaned.length > 220) {
      const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned]
      const chunks: string[] = []
      let buf = ''
      for (const s of sentences) {
        const next = (buf + s).trim()
        if (next.length > 180 && buf) {
          chunks.push(buf.trim())
          buf = s
        } else {
          buf = next
        }
      }
      if (buf.trim()) chunks.push(buf.trim())
      return chunks.slice(0, 3)
    }
    return [cleaned]
  }
  return parts.slice(0, 3)
}

export async function runHireTurn(input: {
  agentId: AgentId
  dataDir: string
  senderId: string
  userText: string
}): Promise<{ reply: string; bubbles: string[]; source: 'gmi' | 'local' }> {
  const agent = getAgent(input.agentId)
  const history = loadThread(input.dataDir, input.senderId)
  const system = `${buildSystemPrompt(agent, [])}\n\n${skillsPromptBlock(agent.id)}`

  let reply: string
  let source: 'gmi' | 'local' = 'gmi'
  const isFirst = history.length === 0

  try {
    const firstHint = isFirst
      ? '\nThis is their first message to you. Introduce yourself briefly in character, then answer.'
      : ''
    reply = await gmiChat({
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      messages: [
        { role: 'system', content: system + firstHint },
        ...history,
        { role: 'user', content: input.userText },
      ],
    })
  } catch (err) {
    console.warn(`[${agent.id}] GMI fallback:`, err)
    if (isFirst) {
      const intros: Record<AgentId, string> = {
        friend:
          "Hey — I'm Alpha, your friend in texts. I'm here. What's going on?",
        coworker:
          "Alpha (Coworker) here. Send me the raw notes and I'll tighten them.",
        cofounder:
          "Alpha(CoFounder). What's the real decision this week?",
      }
      reply = `${intros[agent.id]}\n\n${runAgentLocally(agent, input.userText)}`
    } else {
      reply = runAgentLocally(agent, input.userText)
    }
    source = 'local'
  }

  appendThread(input.dataDir, input.senderId, [
    { role: 'user', content: input.userText },
    { role: 'assistant', content: reply },
  ])

  return { reply, bubbles: splitBubbles(reply), source }
}

export { getAgent }
