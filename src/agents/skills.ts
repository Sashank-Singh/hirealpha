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
    tools: ['gmail', 'calendar.read', 'calendar.soft_book', 'maps', 'spotify'],
    executable: ['gmail', 'calendar', 'maps'],
    miniApps: [
      'pick_night', 'check_in', 'spiral_options', 'open_loops', 'relationship_radar', 'drop_zone',
      'nutrition', 'habit_streak', 'mood_tracker', 'workout_log', 'learning_queue', 'weekly_review',
      'networking_crm', 'pipeline_board', 'sleep_tracker', 'gratitude_journal', 'spending_snapshot', 'mirror',
    ],
    liveMiniApps: ['pick_night'],
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
    executable: ['gmail', 'calendar', 'slack', 'linear'],
    miniApps: [
      'approve_send', 'pick_slot', 'standup_paste', 'linear_triage', 'open_loops', 'meeting_mode', 'drop_zone',
      'learning_queue', 'weekly_review', 'networking_crm', 'mirror',
    ],
    liveMiniApps: ['standup_paste'],
    deny: ['therapy_mode', 'fundraising_strategy', 'uber_lifestyle'],
  },
  cofounder: {
    tools: ['notion', 'drive', 'stripe.glance', 'calendar.light', 'gmail.draft'],
    executable: ['gmail', 'calendar', 'notion', 'drive'],
    miniApps: [
      'kill_keep_park', 'hire_decision', 'weekly_review', 'approve_investor_note', 'decision_ledger',
      'relationship_radar', 'drop_zone', 'open_loops', 'networking_crm', 'pipeline_board', 'spending_snapshot',
      'mirror',
    ],
    liveMiniApps: ['kill_keep_park'],
    deny: ['standup_scribe', 'friend_comfort', 'silent_ea'],
  },
}

function canonTool(name: string) {
  return name.split('.')[0]
}

/** Prompt block: only live tools, and never mime a disconnected one. */
export function skillsPromptBlock(agentId: AgentId, connected: string[] = []): string {
  const s = SKILLS[agentId]
  const connectedSet = new Set(connected.map(canonTool))
  const live = s.executable.filter((t) => connectedSet.has(t))
  const missing = s.executable.filter((t) => !connectedSet.has(t))
  const lines = [
    live.length
      ? `Live tools you can actually use this turn: ${live.join(', ')}. Use a tool result if one is provided. Never invent a send, book, search, or file.`
      : 'No live tools are connected for this hire.',
    missing.length
      ? `Not connected: ${missing.join(', ')}. If they ask for one of these, offer hirealpha.chat/app and tell them to tap Connect. Do not mime the action.`
      : '',
    `Mini apps that actually run: ${s.liveMiniApps.join(', ') || 'none'}. Put the answer in the text. The card is extra, not a substitute.`,
    `Never act with: ${s.deny.join(', ')}.`,
    'Do not claim you completed a tool action unless a tool result is provided in context.',
  ]
  return lines.filter(Boolean).join('\n')
}
