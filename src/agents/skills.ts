import type { AgentId } from './types'

/** Tools each hire may use. Only list a tool in the live prompt if it is connected and executable. */
export const SKILLS: Record<
  AgentId,
  {
    tools: string[]
    executable: string[]
    miniApps: string[]
    liveMiniApps: string[]
    deny: string[]
  }
> = {
  friend: {
    tools: ['gmail', 'calendar.read', 'calendar.soft_book', 'drive', 'maps', 'plaid', 'spotify', 'youtube', 'whatsapp', 'telegram'],
    executable: ['gmail', 'calendar', 'drive', 'maps', 'plaid', 'spotify', 'youtube', 'whatsapp', 'telegram'],
    miniApps: [
      'home', 'tonight', 'pick_night', 'body', 'later', 'check_in', 'open_loops', 'drop_zone', 'artifact',
      'nutrition', 'habit_streak', 'mood_tracker', 'workout_log', 'learning_queue', 'weekly_review',
      'networking_crm', 'sleep_tracker', 'spending_snapshot', 'gratitude_journal', 'spiral_options', 'relationship_radar',
    ],
    liveMiniApps: ['digest', 'pick_night', 'tonight', 'drop_zone', 'home'],
    deny: ['slack', 'linear', 'github', 'stripe', 'fundraising', 'approve_send', 'pick_slot', 'next_move', 'standup_paste'],
  },
  coworker: {
    tools: [
      'gmail',
      'calendar',
      'slack',
      'notion',
      'linear',
      'github',
      'gitlab',
      'jira',
      'sentry',
      'postman',
      'drive',
      'figma',
      'miro',
      'coda',
      'confluence',
      'airtable',
      'discord',
    ],
    executable: [
      'gmail',
      'calendar',
      'slack',
      'linear',
      'notion',
      'github',
      'gitlab',
      'jira',
      'sentry',
      'postman',
      'drive',
      'figma',
      'miro',
      'coda',
      'confluence',
      'airtable',
      'discord',
    ],
    miniApps: [
      'next_move', 'home', 'approve_send', 'pick_slot', 'standup_paste', 'linear_triage', 'open_loops', 'meeting_mode', 'artifact',
      'drop_zone', 'learning_queue', 'weekly_review', 'networking_crm',
    ],
    liveMiniApps: ['digest', 'home', 'next_move', 'standup_paste', 'approve_send', 'pick_slot', 'linear_triage', 'meeting_mode', 'open_loops', 'weekly_review', 'networking_crm'],
    deny: ['therapy_mode', 'fundraising_strategy', 'uber_lifestyle'],
  },
  cofounder: {
    tools: [
      'notion',
      'drive',
      'stripe.glance',
      'calendar.light',
      'gmail.draft',
      'plaid',
      'quickbooks',
      'hubspot',
      'salesforce',
      'intercom',
      'linear',
      'slack',
      'twitter',
    ],
    executable: [
      'gmail',
      'calendar',
      'notion',
      'drive',
      'stripe',
      'plaid',
      'quickbooks',
      'hubspot',
      'salesforce',
      'intercom',
      'linear',
      'slack',
      'twitter',
    ],
    miniApps: [
      'next_move', 'home', 'kill_keep_park', 'hire_decision', 'weekly_review', 'approve_investor_note', 'decision_ledger', 'artifact',
      'relationship_radar', 'drop_zone', 'open_loops', 'networking_crm', 'pipeline_board', 'spending_snapshot',
    ],
    liveMiniApps: ['digest', 'home', 'next_move', 'kill_keep_park', 'hire_decision', 'approve_investor_note', 'pipeline_board', 'decision_ledger', 'weekly_review', 'networking_crm', 'spending_snapshot'],
    deny: ['standup_scribe', 'friend_comfort', 'silent_ea'],
  },
}

/** Prompt block: only live tools, and never mime a disconnected one. */
export function skillsPromptBlock(agentId: AgentId, connected: string[] = []): string {
  const hireSkills = SKILLS[agentId]
  const live = hireSkills.executable.filter((t) => connected.includes(t))
  const offline = hireSkills.executable.filter((t) => !connected.includes(t))

  const parts: string[] = []

  if (live.length > 0) {
    parts.push(
      `Connected tools (you may use tool results provided in context): ${live.join(', ')}.`,
      'Do not claim you performed an action unless the tool result is present in your context.',
    )
  }

  if (offline.length > 0) {
    parts.push(
      `Not connected yet: ${offline.join(', ')}.`,
      'If the user asks you to read or act on these, tell them they can connect in the HireAlpha console.',
      'Never pretend or mime that you took an action in an offline tool.',
    )
  }

  return parts.join('\n')
}
