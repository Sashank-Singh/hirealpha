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
    tools: ['gmail', 'calendar.read', 'calendar.soft_book', 'drive', 'maps', 'plaid'],
    executable: ['gmail', 'calendar', 'drive', 'maps', 'plaid'],
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
      'drive',
      'figma',
    ],
    executable: ['gmail', 'calendar', 'slack', 'linear', 'notion', 'github', 'drive', 'figma'],
    miniApps: [
      'next_move', 'home', 'approve_send', 'pick_slot', 'standup_paste', 'linear_triage', 'open_loops', 'meeting_mode', 'artifact',
      'drop_zone', 'learning_queue', 'weekly_review', 'networking_crm',
    ],
    liveMiniApps: ['digest', 'home', 'next_move', 'standup_paste', 'approve_send', 'pick_slot', 'linear_triage', 'meeting_mode', 'open_loops', 'weekly_review', 'networking_crm'],
    deny: ['therapy_mode', 'fundraising_strategy', 'uber_lifestyle'],
  },
  cofounder: {
    tools: ['notion', 'drive', 'stripe.glance', 'calendar.light', 'gmail.draft', 'plaid'],
    executable: ['gmail', 'calendar', 'notion', 'drive', 'stripe', 'plaid'],
    miniApps: [
      'next_move', 'home', 'kill_keep_park', 'hire_decision', 'weekly_review', 'approve_investor_note', 'decision_ledger', 'artifact',
      'relationship_radar', 'drop_zone', 'open_loops', 'networking_crm', 'pipeline_board', 'spending_snapshot',
    ],
    liveMiniApps: ['digest', 'home', 'next_move', 'kill_keep_park', 'hire_decision', 'approve_investor_note', 'pipeline_board', 'decision_ledger', 'weekly_review', 'networking_crm', 'spending_snapshot'],
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
      ? `Not connected: ${missing.join(', ')}. If they ask for any of these (or services like bank/Plaid, Gmail, Calendar, Slack, Notion, GitHub, Stripe), give them the direct link to connect it instantly: https://hirealpha.chat/app/hires/${agentId}?connect=<tool_name> (e.g. https://hirealpha.chat/app/hires/${agentId}?connect=${missing[0]}). Never mime the action.`
      : '',
    `Mini apps that actually run: ${s.liveMiniApps.join(', ') || 'none'}. Put the answer in the text. The card is extra, not a substitute.`,
    `Never act with: ${s.deny.join(', ')}.`,
    'Do not claim you completed a tool action unless a tool result is provided in context.',
    'Never say you sent mail, booked a calendar event, or texted someone. Writes need a card tap: Send, Book, or Text.',
    'Never diagnose. Never give legal advice. Never venmo, wire, charge a card, or otherwise move money.',
    'Never replace a human for grief, a live negotiation, or taste they have not taught. Listen. Prep. Ask. Do not close for them and do not invent who they are.',
    agentId === 'friend'
      ? 'If they ask to prep for a person, stitch calendar, People notes, and the mail thread into one text. If they ask to run the week, the weekly review is already written from logs. Private logs can save themselves. Mail, texts, calendar, and money over the spend cap still need a tap. Do not ask them to pull pieces or fill the card.'
      : '',
    'When tool results are present in context, NEVER say you cannot access the data or that a tool is not connected. The results ARE your answer — use them directly. Do not hedge, apologize, or ask the user to connect something that already returned data.',
  ]
  return lines.filter(Boolean).join('\n')
}
