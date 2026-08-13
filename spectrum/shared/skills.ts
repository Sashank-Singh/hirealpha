import type { AgentId } from '../../src/agents/types'

/** Tools each hire may mention or call. Shared OAuth later; policy differs per hire. */
export const SKILLS: Record<
  AgentId,
  {
    tools: string[]
    miniApps: string[]
    deny: string[]
  }
> = {
  friend: {
    tools: ['gmail', 'calendar.read', 'calendar.soft_book', 'maps', 'spotify'],
    miniApps: ['pick_night', 'check_in', 'spiral_options'],
    deny: ['slack', 'linear', 'github', 'stripe', 'fundraising'],
  },
  coworker: {
    tools: [
      'gmail',
      'calendar',
      'slack',
      'notion',
      'linear',
      'github',
      'drive',
      'figma',
    ],
    miniApps: ['approve_send', 'pick_slot', 'standup_paste', 'linear_triage'],
    deny: ['therapy_mode', 'fundraising_strategy', 'uber_lifestyle'],
  },
  cofounder: {
    tools: ['notion', 'drive', 'stripe.glance', 'calendar.light', 'gmail.draft'],
    miniApps: ['kill_keep_park', 'hire_decision', 'weekly_focus', 'approve_investor_note'],
    deny: ['standup_scribe', 'friend_comfort', 'silent_ea'],
  },
}

export function skillsPromptBlock(agentId: AgentId): string {
  const s = SKILLS[agentId]
  return [
    `Skills you may use when connected: ${s.tools.join(', ') || 'none yet'}.`,
    `Mini apps you may offer: ${s.miniApps.join(', ')}.`,
    `Never act with: ${s.deny.join(', ')}.`,
    'Do not claim you completed a tool action unless a tool result is provided in context.',
  ].join('\n')
}
