import { AGENTS, type AgentId } from './agents'

const REPLIES: Record<AgentId, string[]> = {
  friend: [
    'Got you. Want the honest take or the soft one?',
    'Okay, breathe once. What is the real worry under that?',
    'I am with you. One next step, not the whole mountain.',
  ],
  coworker: [
    'On it. Want bullets, a draft, or a blocker list?',
    'Noted. I can prep a standup version in under a minute.',
    'Clear. What is the deadline and who needs the update?',
  ],
  cofounder: [
    'Pushback: are you solving conversion or buying confidence?',
    'That hire only makes sense if the funnel already closes.',
    'Hard call, but delay burns more than a sharp no.',
  ],
}

export function mockAgentReply(agentId: AgentId, userText: string): string {
  const pool = REPLIES[agentId]
  const idx = Math.abs(hash(`${agentId}:${userText}`)) % pool.length
  return pool[idx]
}

function hash(input: string) {
  let h = 0
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0
  return h
}

export function agentLabel(id: AgentId) {
  return AGENTS.find((a) => a.id === id)?.imsgName ?? 'Alpha'
}
