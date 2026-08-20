import type { AgentId } from '../../src/agents/types'

/** Tools each hire may mention or call. Shared OAuth later; policy differs per hire. */
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
    tools: ['gmail', 'calendar.read', 'calendar.soft_book', 'drive', 'maps'],
    executable: ['gmail', 'calendar', 'drive', 'maps'],
    miniApps: [
      'next_move', 'pick_night', 'check_in', 'open_loops', 'drop_zone',
      'nutrition', 'habit_streak', 'mood_tracker', 'workout_log', 'learning_queue', 'weekly_review',
      'networking_crm', 'sleep_tracker', 'spending_snapshot', 'mirror', 'gratitude_journal', 'spiral_options', 'relationship_radar',
    ],
    liveMiniApps: ['digest', 'pick_night', 'drop_zone'],
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
    executable: ['gmail', 'calendar', 'slack', 'linear', 'notion', 'github', 'drive', 'figma'],
    miniApps: [
      'next_move', 'approve_send', 'pick_slot', 'standup_paste', 'linear_triage', 'open_loops', 'meeting_mode',
      'drop_zone', 'learning_queue', 'weekly_review', 'networking_crm',
    ],
    liveMiniApps: ['next_move', 'standup_paste', 'approve_send', 'pick_slot', 'linear_triage'],
    deny: ['therapy_mode', 'fundraising_strategy', 'uber_lifestyle'],
  },
  cofounder: {
    tools: ['notion', 'drive', 'stripe.glance', 'calendar.light', 'gmail.draft'],
    executable: ['gmail', 'calendar', 'notion', 'drive', 'stripe'],
    miniApps: [
      'next_move', 'kill_keep_park', 'hire_decision', 'weekly_review', 'approve_investor_note', 'decision_ledger',
      'relationship_radar', 'drop_zone', 'open_loops', 'networking_crm', 'pipeline_board', 'spending_snapshot',
    ],
    liveMiniApps: ['next_move', 'kill_keep_park', 'hire_decision', 'approve_investor_note'],
    deny: ['standup_scribe', 'friend_comfort', 'silent_ea'],
  },
}

function canonTool(name: string) {
  return name.split('.')[0]
}

export function skillsPromptBlock(agentId: AgentId, connected: string[] = []): string {
  const s = SKILLS[agentId]
  const connectedSet = new Set(connected.map(canonTool))
  const freeLookupTools = new Set(['maps'])
  const live = s.executable.filter((t) => connectedSet.has(t))
  const missing = s.executable.filter((t) => !connectedSet.has(t) && !freeLookupTools.has(t))
  const lines = [
    'Free live lookups available without a connector: web search and OpenStreetMap place search. Use their results when provided; do not claim they are unavailable.',
    live.length
      ? `Live tools you can actually use this turn: ${live.join(', ')}. Use a tool result if one is provided. Never invent a send, book, search, or file.`
      : 'No live tools are connected for this hire.',
    missing.length
      ? `Not connected: ${missing.join(', ')}. If they ask for one of these, offer hirealpha.chat/app and tell them to tap Connect. Do not mime the action.`
      : '',
    `Mini apps that actually run: ${s.liveMiniApps.join(', ') || 'none'}. Put the answer in the text. The card is extra, not a substitute.`,
    `Never act with: ${s.deny.join(', ')}.`,
    'Do not claim you completed a tool action unless a tool result is provided in context.',
    'When tool results are present in context, NEVER say you cannot access the data or that a tool is not connected. The results ARE your answer — use them directly. Do not hedge, apologize, or ask the user to connect something that already returned data.',
  ]
  return lines.filter(Boolean).join('\n')
}
