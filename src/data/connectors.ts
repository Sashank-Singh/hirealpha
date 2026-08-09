import {
  siGmail,
  siGooglecalendar,
  siSlack,
  siNotion,
  siLinear,
  siGithub,
  siGoogledrive,
  siSpotify,
  siUber,
  siStripe,
  siFigma,
  siGooglemaps,
  type SimpleIcon,
} from 'simple-icons'

export type ConnectorId =
  | 'gmail'
  | 'calendar'
  | 'slack'
  | 'notion'
  | 'linear'
  | 'github'
  | 'drive'
  | 'spotify'
  | 'uber'
  | 'stripe'
  | 'figma'
  | 'maps'

export interface Connector {
  id: ConnectorId
  name: string
  description: string
  icon: SimpleIcon
  category: 'work' | 'life' | 'build'
}

export const CONNECTORS: Connector[] = [
  { id: 'gmail', name: 'Gmail', description: 'Read and draft email from texts.', icon: siGmail, category: 'work' },
  { id: 'calendar', name: 'Calendar', description: 'Check and book time.', icon: siGooglecalendar, category: 'work' },
  { id: 'slack', name: 'Slack', description: 'Pull channel context and draft replies.', icon: siSlack, category: 'work' },
  { id: 'notion', name: 'Notion', description: 'Search docs and capture notes.', icon: siNotion, category: 'work' },
  { id: 'linear', name: 'Linear', description: 'Track issues and ship updates.', icon: siLinear, category: 'build' },
  { id: 'github', name: 'GitHub', description: 'PRs, issues, and repo status.', icon: siGithub, category: 'build' },
  { id: 'drive', name: 'Drive', description: 'Find files without leaving Messages.', icon: siGoogledrive, category: 'work' },
  { id: 'spotify', name: 'Spotify', description: 'Playlists and focus queues.', icon: siSpotify, category: 'life' },
  { id: 'uber', name: 'Uber', description: 'Rides when you say go.', icon: siUber, category: 'life' },
  { id: 'stripe', name: 'Stripe', description: 'Payments and revenue glances.', icon: siStripe, category: 'build' },
  { id: 'figma', name: 'Figma', description: 'Design links and file status.', icon: siFigma, category: 'build' },
  { id: 'maps', name: 'Maps', description: 'Places, ETAs, and directions.', icon: siGooglemaps, category: 'life' },
]

const STORAGE_KEY = 'hirealpha-connectors'

export function loadConnectedIds(): ConnectorId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ConnectorId[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveConnectedIds(ids: ConnectorId[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
}
