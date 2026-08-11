import { ALPHA, ALPHA_COFOUNDER, ALPHA_COWORKER } from './definitions'
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
  const tools =
    connectedApps.length > 0
      ? `\nConnected tools for this user: ${connectedApps.join(', ')}.\nYou may suggest using them. Do not claim you already completed an action unless the tool result is provided.`
      : `\nNo tools connected yet. If an action needs Gmail, Calendar, Slack, etc., say what you would connect or check.`

  return `${agent.systemPrompt}\n${tools}`
}
