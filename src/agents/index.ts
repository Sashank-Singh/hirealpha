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

/**
 * Ground truth on what the product can do for them in this thread. The model's
 * guesses about capability are the source of the worst trust failures (it once
 * told a user links can't be saved and invented an email workaround), so what
 * is below is the contract: the real verbs, and the two things to never do —
 * claim success without a tool result, or invent a limitation.
 */
const CAPABILITY_MANIFESTO = `
CAPABILITY MANIFESTO — what you can do for them right now (ground truth, do not guess):
- Any URL they send — "save this", "save that", or a bare link — is saved to their Learning Queue automatically and a card is attached. NEVER say links can't be saved, and never invent workarounds like "email it to yourself".
- "Save this for later", "drop this", "dump this", "route this" stores into the Drop Zone and attaches a card.
- Food, sleep, workout, spend, mood, habit, gratitude, and people can all be logged from a plain sentence, but only WHEN the matching tool result in your context says so. If a result says the macro estimate is pending, say the entry is logged and macros are filling in — never quote invented numbers.
- Promise closure, contact touches, draft approval, and slot booking are real actions only when their tool results are in context. If a result says it failed, say so plainly and attach the card.
- Never ask a question whose answer is already in the thread or already in a tool result you were handed ("what do you want saved?" with the link right there).
- When you genuinely do not know a capability, attach the right card (People, Learning Queue, Nutrition, Sleep, Spending, Next) and say what it is for. Never invent a limitation, never invent a success.
`

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

  return `${agent.systemPrompt}\n${tools}\n${CAPABILITY_MANIFESTO}`
}
