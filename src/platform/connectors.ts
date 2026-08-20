import type { AgentId } from '../agents/types'
import { SKILLS } from '../agents/skills'

export type ConnectorId =
  | 'gmail'
  | 'calendar'
  | 'slack'
  | 'notion'
  | 'linear'
  | 'github'
  | 'drive'
  | 'figma'
  | 'maps'
  | 'spotify'
  | 'stripe'

export interface ConnectorDef {
  id: ConnectorId
  name: string
  blurb: string
  /** Tool id prefixes / exact tools that map to this connector */
  toolMatchers: string[]
  /**
   * True when the tool works without an OAuth connection (e.g. OSM-backed Maps).
   * Show "On" badge and skip the Connect button; never show a dead connect flow.
   */
  noAuth?: boolean
}

export const CONNECTOR_CATALOG: ConnectorDef[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    blurb: 'Read and draft email from texts.',
    toolMatchers: ['gmail'],
  },
  {
    id: 'calendar',
    name: 'Google Calendar',
    blurb: 'Check free time and soft book plans.',
    toolMatchers: ['calendar'],
  },
  {
    id: 'slack',
    name: 'Slack',
    blurb: 'Catch threads and draft follow ups.',
    toolMatchers: ['slack'],
  },
  {
    id: 'notion',
    name: 'Notion',
    blurb: 'Pull notes, docs, and decisions.',
    toolMatchers: ['notion'],
  },
  {
    id: 'linear',
    name: 'Linear',
    blurb: 'Triage issues and standup blockers.',
    toolMatchers: ['linear'],
  },
  {
    id: 'github',
    name: 'GitHub',
    blurb: 'PRs, issues, and ship status.',
    toolMatchers: ['github'],
  },
  {
    id: 'drive',
    name: 'Google Drive',
    blurb: 'Find decks and shared files.',
    toolMatchers: ['drive'],
  },
  {
    id: 'figma',
    name: 'Figma',
    blurb: 'Link design context for reviews.',
    toolMatchers: ['figma'],
  },
  {
    id: 'maps',
    name: 'Google Maps',
    blurb: 'Pick places and get there.',
    toolMatchers: ['maps'],
    noAuth: true,
  },
  {
    id: 'spotify',
    name: 'Spotify',
    blurb: 'Mood and hangout playlists.',
    toolMatchers: ['spotify'],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    blurb: 'Glance revenue, not move money.',
    toolMatchers: ['stripe'],
  },
]

export interface ContextField {
  id: string
  label: string
  hint: string
  placeholder: string
  multiline?: boolean
  /** Renders a timezone <select> instead of a text input. */
  timezone?: boolean
}

export const TIMEZONES: string[] = (() => {
  try {
    const zones = Intl.supportedValuesOf('timeZone')
    if (zones?.length) return zones
  } catch {
    /* fall through */
  }
  return [
    'America/Los_Angeles',
    'America/Denver',
    'America/Chicago',
    'America/New_York',
    'Europe/London',
    'Europe/Paris',
    'Asia/Kolkata',
    'Asia/Tokyo',
    'Australia/Sydney',
  ]
})()

/** Context we ask for per hire. Only shown for bought hires. */
export const CONTEXT_FIELDS: Record<AgentId, ContextField[]> = {
  friend: [
    {
      id: 'preferred_name',
      label: 'What should Friend call you?',
      hint: 'Name or nickname in texts.',
      placeholder: 'e.g. Sashank',
    },
    {
      id: 'timezone',
      label: 'Timezone',
      hint: 'For check ins, plans, and reminders.',
      placeholder: 'America/Los_Angeles',
      timezone: true,
    },
    {
      id: 'people',
      label: 'People to remember',
      hint: 'Names that matter in your life.',
      placeholder: 'Mom, Alex, …',
      multiline: true,
    },
    {
      id: 'check_ins',
      label: 'Check in style',
      hint: 'How often / how soft.',
      placeholder: 'Light Sunday check in is fine',
      multiline: true,
    },
  ],
  coworker: [
    {
      id: 'company',
      label: 'Company',
      hint: 'Where you work together.',
      placeholder: 'e.g. HireAlpha',
    },
    {
      id: 'role_title',
      label: 'Your role',
      hint: 'So standup language fits.',
      placeholder: 'e.g. Founding engineer',
    },
    {
      id: 'timezone',
      label: 'Timezone',
      hint: 'For standups, syncs, and reminders.',
      placeholder: 'America/Los_Angeles',
      timezone: true,
    },
    {
      id: 'projects',
      label: 'Active projects',
      hint: 'What Coworker should already know.',
      placeholder: 'Auth rewrite, staging fixes, …',
      multiline: true,
    },
    {
      id: 'standup_time',
      label: 'Standup / sync time',
      hint: 'Optional daily rhythm.',
      placeholder: 'Weekdays 9:30am',
    },
  ],
  cofounder: [
    {
      id: 'company_name',
      label: 'Company',
      hint: 'The thing you are building.',
      placeholder: 'e.g. HireAlpha',
    },
    {
      id: 'stage',
      label: 'Stage',
      hint: 'Pre seed, seed, PMF hunt, …',
      placeholder: 'e.g. Pre seed, building wedge',
    },
    {
      id: 'timezone',
      label: 'Timezone',
      hint: 'For check-ins and reminders.',
      placeholder: 'America/Los_Angeles',
      timezone: true,
    },
    {
      id: 'weekly_focus',
      label: 'This week’s real decision',
      hint: 'What Cofounder should push on.',
      placeholder: 'Ship hire flow vs more demos',
      multiline: true,
    },
    {
      id: 'hard_nos',
      label: 'Hard constraints',
      hint: 'Cash, time, or principles.',
      placeholder: 'No VP sales before PMF',
      multiline: true,
    },
  ],
}

function toolMatchesConnector(tool: string, connector: ConnectorDef): boolean {
  return connector.toolMatchers.some(
    (m) => tool === m || tool.startsWith(`${m}.`) || tool.startsWith(m),
  )
}

/** Connectors this hire is allowed to use (from skills allowlist). */
export function connectorsForHire(agentId: AgentId): ConnectorDef[] {
  const skills = SKILLS[agentId]
  if (!skills) return []
  const tools = skills.tools
  return CONNECTOR_CATALOG.filter((c) => tools.some((t) => toolMatchesConnector(t, c)))
}

export function setupProgress(input: {
  agentId: AgentId
  connected: ConnectorId[]
  context: Record<string, string>
}): { done: number; total: number; pct: number; missingConnectors: ConnectorDef[]; missingContext: ContextField[] } {
  const needed = connectorsForHire(input.agentId)
  const fields = CONTEXT_FIELDS[input.agentId]
  const missingConnectors = needed.filter((c) => !input.connected.includes(c.id))
  const missingContext = fields.filter((f) => !(input.context[f.id] || '').trim())
  const done =
    needed.length -
    missingConnectors.length +
    (fields.length - missingContext.length)
  const total = needed.length + fields.length
  return {
    done,
    total,
    pct: total === 0 ? 100 : Math.round((done / total) * 100),
    missingConnectors,
    missingContext,
  }
}
