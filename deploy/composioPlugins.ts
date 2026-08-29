/** Read-only Composio tool slugs and compact rendering for live iMessage tools. */

export function formatComposioData(data: unknown, limit = 12): string {
  const lines = collectLabels(data, limit)
  if (lines.length) return lines.map((l) => `- ${l}`).join('\n')
  const raw = JSON.stringify(data ?? {})
  if (raw === '{}' || raw === 'null') return ''
  return raw.slice(0, 4000)
}

export function composioLooksFailed(text: string | null | undefined): boolean {
  if (!text) return true
  return /^Tool \S+ failed:/i.test(text) || /^Calendar lookup failed/i.test(text) || /^Gmail lookup failed/i.test(text)
}

const LABEL_KEYS = [
  'title',
  'summary',
  'name',
  'subject',
  'text',
  'query',
  'permalink',
  'html_url',
  'url',
  'email',
  'from',
  'amount',
  'formatted_amount',
  'status',
]

function collectLabels(data: unknown, limit: number, depth = 0, out: string[] = []): string[] {
  if (out.length >= limit || data == null || depth > 6) return out
  if (Array.isArray(data)) {
    for (const item of data) {
      collectLabels(item, limit, depth + 1, out)
      if (out.length >= limit) break
    }
    return out
  }
  if (typeof data !== 'object') {
    const s = String(data).trim()
    if (s && s.length < 220) out.push(s)
    return out
  }
  const o = data as Record<string, unknown>
  const bits: string[] = []
  for (const k of LABEL_KEYS) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) bits.push(v.trim().slice(0, 160))
    else if (typeof v === 'number') bits.push(String(v))
  }
  if (bits.length) out.push(bits.slice(0, 3).join(' · '))
  else {
    for (const v of Object.values(o)) {
      collectLabels(v, limit, depth + 1, out)
      if (out.length >= limit) break
    }
  }
  return out
}

export const COMPOSIO_READ: Record<
  string,
  { slugs: string[]; args: (message: string) => Record<string, unknown>; empty: string }
> = {
  gmail: {
    slugs: ['GMAIL_FETCH_EMAILS'],
    args: (message) => ({
      max_results: 8,
      query: /\b(debrief|digest|brief)\b/i.test(message)
        ? '(newer_than:1d) OR (is:important newer_than:2d)'
        : 'newer_than:5d',
      verbose: false,
    }),
    empty: 'Gmail lookup failed. Do not invent emails. Tell them to reconnect Gmail in Settings.',
  },
  slack: {
    slugs: ['SLACK_SEARCH_MESSAGES', 'SLACK_LIST_CHANNELS', 'SLACK_FETCH_CONVERSATION_HISTORY'],
    args: (message) => ({ query: message.slice(0, 80), limit: 8 }),
    empty: 'Slack is connected but nothing came back. Say that. Do not invent a thread.',
  },
  linear: {
    slugs: ['LINEAR_LIST_ISSUES', 'LINEAR_LIST_LINEAR_ISSUES', 'LINEAR_GET_ISSUES'],
    args: () => ({ limit: 8 }),
    empty: 'Linear is connected but nothing came back. Say that. Do not invent tickets.',
  },
  notion: {
    slugs: ['NOTION_SEARCH', 'NOTION_SEARCH_NOTION_PAGE', 'NOTION_FETCH_DATA'],
    args: (message) => ({ query: message.slice(0, 80) }),
    empty: 'Notion is connected but the search failed. Say that. Do not invent a page.',
  },
  drive: {
    slugs: ['GOOGLEDRIVE_LIST_FILES', 'GOOGLEDRIVE_FIND_FILE', 'GOOGLE_DRIVE_LIST_FILES'],
    args: (message) => ({ pageSize: 8, q: message.slice(0, 40), query: message.slice(0, 40) }),
    empty: 'Drive is connected but nothing came back. Say that. Do not invent a file.',
  },
  github: {
    slugs: [
      'GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER',
      'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      'GITHUB_LIST_PULL_REQUESTS',
    ],
    args: () => ({ per_page: 8, state: 'open', filter: 'assigned' }),
    empty: 'GitHub is connected but nothing came back. Say that. Do not invent a PR.',
  },
  figma: {
    slugs: ['FIGMA_GET_CURRENT_USER', 'FIGMA_DISCOVER_FIGMA_RESOURCES'],
    args: () => ({}),
    empty: 'Figma is connected but nothing came back. Say that. Do not invent a file.',
  },
  spotify: {
    slugs: [
      'SPOTIFY_GET_CURRENTLY_PLAYING_TRACK',
      'SPOTIFY_GET_RECENTLY_PLAYED_TRACKS',
      'SPOTIFY_SEARCH_FOR_ITEM',
    ],
    args: (message) => ({ limit: 8, q: message.slice(0, 60), type: 'track,playlist' }),
    empty: 'Spotify is connected but nothing came back. Say that. Do not invent a song.',
  },
  stripe: {
    slugs: ['STRIPE_RETRIEVE_BALANCE', 'STRIPE_LIST_CHARGES', 'STRIPE_LIST_INVOICES'],
    args: () => ({ limit: 8 }),
    empty: 'Stripe is connected but nothing came back. Say the glance failed. Do not invent revenue.',
  },
  maps: {
    slugs: ['GOOGLEMAPS_TEXT_SEARCH', 'GOOGLEMAPS_SEARCH_PLACES', 'GOOGLE_MAPS_SEARCH_PLACES'],
    args: (message) => {
      const q = message.slice(0, 80) || 'quiet restaurant nearby'
      return { query: q, q }
    },
    empty: 'Maps is connected but nothing came back.',
  },
  plaid: {
    slugs: ['PLAID_GET_ACCOUNTS', 'PLAID_GET_BALANCE', 'PLAID_GET_TRANSACTIONS'],
    args: () => ({}),
    empty: 'Plaid / Bank is connected but nothing came back. Say that. Do not invent balances.',
  },
}
