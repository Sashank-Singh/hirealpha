import {
  siAirtable,
  siCalendly,
  siCoda,
  siConfluence,
  siDiscord,
  siFigma,
  siGithub,
  siGitlab,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siGooglemaps,
  siHubspot,
  siIntercom,
  siJira,
  siLinear,
  siMiro,
  siNotion,
  siPostman,
  siQuickbooks,
  siSalesforce,
  siSentry,
  siSlack,
  siSpotify,
  siStripe,
  siTelegram,
  siWhatsapp,
  siX,
  siYoutube,
  type SimpleIcon,
} from 'simple-icons'
import type { ConnectorId } from './connectors'

const PLAID_ICON: SimpleIcon = {
  title: 'Plaid',
  slug: 'plaid',
  hex: '111111',
  source: 'https://plaid.com',
  svg: '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2 4h20v3H2V4zm2 5h3v9H4V9zm6 0h4v9h-4V9zm7 0h3v9h-3V9zM2 19h20v2H2v-2z"/></svg>',
  path: 'M2 4h20v3H2V4zm2 5h3v9H4V9zm6 0h4v9h-4V9zm7 0h3v9h-3V9zM2 19h20v2H2v-2z',
}

const ICONS: Record<ConnectorId, SimpleIcon> = {
  gmail: siGmail,
  calendar: siGooglecalendar,
  maps: siGooglemaps,
  drive: siGoogledrive,
  spotify: siSpotify,
  slack: siSlack,
  notion: siNotion,
  linear: siLinear,
  github: siGithub,
  gitlab: siGitlab,
  jira: siJira,
  sentry: siSentry,
  postman: siPostman,
  coda: siCoda,
  confluence: siConfluence,
  airtable: siAirtable,
  figma: siFigma,
  miro: siMiro,
  hubspot: siHubspot,
  salesforce: siSalesforce,
  intercom: siIntercom,
  discord: siDiscord,
  whatsapp: siWhatsapp,
  telegram: siTelegram,
  twitter: siX,
  calendly: siCalendly,
  youtube: siYoutube,
  stripe: siStripe,
  plaid: PLAID_ICON,
  quickbooks: siQuickbooks,
}

function fillFor(hex: string) {
  const n = Number.parseInt(hex, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return lum < 0.18 ? '#f4f4f5' : `#${hex}`
}

export function ConnectorLogo({ id, size = 20 }: { id: ConnectorId; size?: number }) {
  const icon = ICONS[id]
  if (!icon) return null
  const mark = Math.round(size * 0.7)
  return (
    <span className="conn-mark" aria-hidden="true" style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg viewBox="0 0 24 24" width={mark} height={mark} focusable="false">
        <path d={icon.path} fill={fillFor(icon.hex)} />
      </svg>
    </span>
  )
}
