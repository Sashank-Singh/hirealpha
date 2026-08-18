import {
  siFigma,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siGooglemaps,
  siLinear,
  siNotion,
  siSlack,
  siSpotify,
  siStripe,
  type SimpleIcon,
} from 'simple-icons'
import type { ConnectorId } from './connectors'

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
  figma: siFigma,
  stripe: siStripe,
}

function fillFor(hex: string) {
  const n = Number.parseInt(hex, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return lum < 0.18 ? '#f4f4f5' : `#${hex}`
}

export function ConnectorLogo({ id, size = 28 }: { id: ConnectorId; size?: number }) {
  const icon = ICONS[id]
  const mark = Math.round(size * 0.58)
  return (
    <span className="conn-mark" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={mark} height={mark} focusable="false">
        <path d={icon.path} fill={fillFor(icon.hex)} />
      </svg>
    </span>
  )
}
