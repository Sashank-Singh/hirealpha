import { ALPHA, ALPHA_COFOUNDER, ALPHA_COWORKER } from './definitions'
import { SKILLS } from './skills'
import type { AgentDefinition, AgentId, ChatMessage, Msg } from './types'

export type { AgentDefinition, AgentId, ChatMessage, Msg } from './types'
export { ALPHA, ALPHA_COWORKER, ALPHA_COFOUNDER } from './definitions'
export { SKILLS, skillsPromptBlock } from './skills'

/** All hireable agents, product order */
export const AGENTS: AgentDefinition[] = [ALPHA, ALPHA_COWORKER, ALPHA_COFOUNDER]

export function getAgent(id: AgentId): AgentDefinition {
  return AGENTS.find((a) => a.id === id) ?? ALPHA
}

export function getAgentByPhone(phone: string): AgentDefinition | undefined {
  const normalized = phone.replace(/[^\d+]/g, '')
  return AGENTS.find((a) => a.phoneNumber === normalized || a.phoneNumber.endsWith(normalized.slice(-10)))
}

/** Convert UI thread messages into model chat messages */
export function toChatMessages(thread: Msg[]): ChatMessage[] {
  return thread.map((m) => ({
    role: m.from === 'me' ? 'user' : 'assistant',
    content: m.text,
  }))
}

export function buildSystemPrompt(agent: AgentDefinition, connectedApps: string[] = []): string {
  const live = SKILLS[agent.id].executable.filter((t) => connectedApps.includes(t))
  const tools =
    live.length > 0
      ? `\nLive tools for this user: ${live.join(', ')}.\nYou may use a tool result if one is provided. Do not claim you completed an action unless the tool result is in context.`
      : `\nNo live tools connected yet. If they ask for Gmail, Calendar, or another tool this hire can run, tell them to open hirealpha.chat/app and tap Connect. Do not mime the action.`

  return `${agent.systemPrompt}\n${tools}`
}
