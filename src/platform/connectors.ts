import type { AgentId } from '../agents/types'
import { SKILLS } from '../agents/skills'

export type ConnectorId =
  | 'gmail'
  | 'calendar'
  | 'slack'
  | 'notion'
  | 'linear'
  | 'github'
  | 'gitlab'
  | 'jira'
  | 'sentry'
  | 'postman'
  | 'drive'
  | 'coda'
  | 'confluence'
  | 'airtable'
  | 'figma'
  | 'miro'
  | 'hubspot'
  | 'salesforce'
  | 'intercom'
  | 'discord'
  | 'whatsapp'
  | 'telegram'
  | 'twitter'
  | 'calendly'
  | 'maps'
  | 'spotify'
  | 'youtube'
  | 'stripe'
  | 'plaid'
  | 'quickbooks'

export interface ConnectorDef {
  id: ConnectorId
  name: string
  category: 'Communication' | 'Productivity' | 'Development' | 'CRM & Sales' | 'Finance' | 'Media & Lifestyle'
  blurb: string
  /** Tool id prefixes / exact tools that map to this connector */
  toolMatchers: string[]
  /**
   * True when the tool works without an OAuth connection (e.g. OSM-backed Maps).
   */
  noAuth?: boolean
}

export const CONNECTOR_CATALOG: ConnectorDef[] = [
  // Communication
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'Communication',
    blurb: 'Read, search, and draft email messages.',
    toolMatchers: ['gmail'],
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'Communication',
    blurb: 'Catch threads, channel updates, and send DMs.',
    toolMatchers: ['slack'],
  },
  {
    id: 'discord',
    name: 'Discord',
    category: 'Communication',
    blurb: 'Monitor server channels and webhook notices.',
    toolMatchers: ['discord'],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    category: 'Communication',
    blurb: 'Direct message relay and thread follow-ups.',
    toolMatchers: ['whatsapp'],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    category: 'Communication',
    blurb: 'Bot notifications and group summaries.',
    toolMatchers: ['telegram'],
  },
  {
    id: 'twitter',
    name: 'X (Twitter)',
    category: 'Communication',
    blurb: 'Search tweets, mentions, and draft posts.',
    toolMatchers: ['twitter', 'x'],
  },

  // Productivity & Scheduling
  {
    id: 'calendar',
    name: 'Google Calendar',
    category: 'Productivity',
    blurb: 'Check free/busy time and book meetings.',
    toolMatchers: ['calendar'],
  },
  {
    id: 'calendly',
    name: 'Calendly',
    category: 'Productivity',
    blurb: 'Share booking slots and fetch schedule events.',
    toolMatchers: ['calendly'],
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Productivity',
    blurb: 'Query databases, pull meeting notes, and edit pages.',
    toolMatchers: ['notion'],
  },
  {
    id: 'drive',
    name: 'Google Drive',
    category: 'Productivity',
    blurb: 'Find decks, spreadsheets, and shared docs.',
    toolMatchers: ['drive'],
  },
  {
    id: 'coda',
    name: 'Coda',
    category: 'Productivity',
    blurb: 'Search team docs, tables, and project wikis.',
    toolMatchers: ['coda'],
  },
  {
    id: 'confluence',
    name: 'Confluence',
    category: 'Productivity',
    blurb: 'Internal knowledge base and company wiki search.',
    toolMatchers: ['confluence'],
  },
  {
    id: 'airtable',
    name: 'Airtable',
    category: 'Productivity',
    blurb: 'Query records, update bases, and sync rows.',
    toolMatchers: ['airtable'],
  },

  // Development & Engineering
  {
    id: 'linear',
    name: 'Linear',
    category: 'Development',
    blurb: 'Triage backlog, assign issues, and track sprints.',
    toolMatchers: ['linear'],
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Development',
    blurb: 'Review pull requests, issues, and commit statuses.',
    toolMatchers: ['github'],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    category: 'Development',
    blurb: 'Inspect pipelines, merge requests, and repos.',
    toolMatchers: ['gitlab'],
  },
  {
    id: 'jira',
    name: 'Jira',
    category: 'Development',
    blurb: 'Create tickets, inspect sprints, and track epics.',
    toolMatchers: ['jira'],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Development',
    blurb: 'Monitor exceptions, stacktraces, and release errors.',
    toolMatchers: ['sentry'],
  },
  {
    id: 'postman',
    name: 'Postman',
    category: 'Development',
    blurb: 'Inspect API collections, environments, and mock runs.',
    toolMatchers: ['postman'],
  },

  // Design & Product
  {
    id: 'figma',
    name: 'Figma',
    category: 'Productivity',
    blurb: 'Link design frames, components, and review comments.',
    toolMatchers: ['figma'],
  },
  {
    id: 'miro',
    name: 'Miro',
    category: 'Productivity',
    blurb: 'Extract whiteboard diagrams and brainstorming boards.',
    toolMatchers: ['miro'],
  },

  // CRM & Sales
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'CRM & Sales',
    blurb: 'Manage leads, contacts, deals, and sales pipelines.',
    toolMatchers: ['hubspot'],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'CRM & Sales',
    blurb: 'Query enterprise accounts, opportunities, and contacts.',
    toolMatchers: ['salesforce'],
  },
  {
    id: 'intercom',
    name: 'Intercom',
    category: 'CRM & Sales',
    blurb: 'Customer support conversations and user tickets.',
    toolMatchers: ['intercom'],
  },

  // Finance & Commerce
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Finance',
    blurb: 'Glance MRR, revenue trends, and subscription status.',
    toolMatchers: ['stripe'],
  },
  {
    id: 'plaid',
    name: 'Plaid',
    category: 'Finance',
    blurb: 'Read bank balances, account transactions, and burn pacing.',
    toolMatchers: ['plaid', 'bank'],
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    category: 'Finance',
    blurb: 'Invoice tracking, expenses, and accounting records.',
    toolMatchers: ['quickbooks'],
  },

  // Media, Search & Lifestyle
  {
    id: 'spotify',
    name: 'Spotify',
    category: 'Media & Lifestyle',
    blurb: 'Playback queue, playlists, and focus music.',
    toolMatchers: ['spotify'],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    category: 'Media & Lifestyle',
    blurb: 'Search video transcripts and saved tutorials.',
    toolMatchers: ['youtube'],
  },
  {
    id: 'maps',
    name: 'Google Maps',
    category: 'Media & Lifestyle',
    blurb: 'Location search, commute times, and place discovery.',
    toolMatchers: ['maps'],
    noAuth: true,
  },
]

export interface ContextField {
  id: string
  label: string
  hint: string
  placeholder: string
  multiline?: boolean
  timezone?: boolean
}

export const TIMEZONES: string[] = (() => {
  try {
    const zones = Intl.supportedValuesOf('timeZone')
    if (zones?.length) return zones
  } catch {
    // fallback
  }
  return [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Phoenix',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Asia/Singapore',
    'Asia/Kolkata',
    'Australia/Sydney',
    'UTC',
  ]
})()

export const HIRE_CONTEXT_FIELDS: Record<AgentId, ContextField[]> = {
  friend: [
    {
      id: 'name',
      label: 'Your name',
      hint: 'What to call you in texts.',
      placeholder: 'Sashank',
    },
    {
      id: 'timezone',
      label: 'Timezone',
      hint: 'Used to anchor morning briefings and scheduling.',
      placeholder: 'America/Los_Angeles',
      timezone: true,
    },
    {
      id: 'location',
      label: 'Home base',
      hint: 'Neighborhood or city for local references.',
      placeholder: 'San Francisco, CA',
    },
  ],
  coworker: [
    {
      id: 'company',
      label: 'Company / Project',
      hint: 'The venture, company, or team you operate in.',
      placeholder: 'HireAlpha',
    },
    {
      id: 'role',
      label: 'Your role',
      hint: 'What you lead (Engineering, Product, Operations).',
      placeholder: 'Founder / CTO',
    },
  ],
  cofounder: [
    {
      id: 'venture',
      label: 'Venture Name',
      hint: 'Name of the startup or organization.',
      placeholder: 'HireAlpha',
    },
    {
      id: 'focus',
      label: 'Primary North Star',
      hint: 'Current top priority this quarter.',
      placeholder: 'Scale self-driving proactive agents',
      multiline: true,
    },
  ],
}

export function connectorsForHire(agentId: AgentId): ConnectorDef[] {
  const executable = new Set(SKILLS[agentId].executable)
  return CONNECTOR_CATALOG.filter((c) =>
    c.toolMatchers.some((matcher) => executable.has(matcher) || c.noAuth),
  )
}
