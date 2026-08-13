import {
  getAgent,
  buildSystemPrompt,
  type AgentId,
} from '../../src/agents'
import { runAgentLocally } from '../../src/agents/runtime'
import { skillsPromptBlock } from './skills'
import { gmiChat } from './gmi'
import { appendThread, loadThread } from './memory'
import { fetchLiveProfile, fetchLiveTools, formatHireContext } from './liveContext'

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

function wantsLiveData(text: string) {
  return /\b(email|inbox|gmail|unread|mail|calendar|meeting|meetings|schedule|agenda|tomorrow|today|slack|notion|linear|github|drive|spotify)\b/i.test(
    text,
  )
}

export async function runHireTurn(input: {
  agentId: AgentId
  dataDir: string
  senderId: string
  userText: string
}): Promise<{ reply: string; bubbles: string[]; source: 'gmi' | 'local' }> {
  const agent = getAgent(input.agentId)
  const history = loadThread(input.dataDir, input.senderId)
  const live = await fetchLiveProfile(input.senderId, agent.id)
  const toolResults =
    live.found && live.hired && wantsLiveData(input.userText)
      ? await fetchLiveTools(input.senderId, agent.id, input.userText)
      : []

  const extras: string[] = []
  if (!live.found) {
    extras.push(
      'This sender is not linked to a HireAlpha account yet. If they ask about email, calendar, or personal setup, tell them to sign in at hirealpha.chat/app with the same phone they are texting from.',
    )
  } else if (!live.hired) {
    extras.push(
      `They have a HireAlpha account (${live.email || 'signed in'}) but have not hired this person yet. Point them to hirealpha.chat/app to hire ${agent.name}.`,
    )
  } else {
    const ctx = formatHireContext(live.context)
    if (ctx) extras.push(ctx)
  }
  if (toolResults.length) {
    extras.push(
      `Live tool results (ground truth, use these, do not invent):\n${toolResults.join('\n\n')}`,
    )
  } else if (live.hired && wantsLiveData(input.userText)) {
    extras.push(
      'They asked about a connected app, but no live data came back. If the tool is not in the connected list, tell them to open this hire at hirealpha.chat/app and tap Connect. Do not invent inbox or calendar contents.',
    )
  }

  const system = [
    buildSystemPrompt(agent, live.connected),
    skillsPromptBlock(agent.id),
    extras.join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n\n')

  let reply: string
  let source: 'gmi' | 'local' = 'gmi'
  const isFirst = history.length === 0

  try {
    const firstHint = isFirst
      ? '\nThis is their first message to you. Introduce yourself briefly in character, then answer.'
      : ''
    reply = await gmiChat({
      temperature: agent.temperature,
      maxTokens: toolResults.length ? Math.max(agent.maxTokens, 700) : agent.maxTokens,
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
