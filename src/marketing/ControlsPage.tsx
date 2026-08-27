import { Link } from 'react-router-dom'
import { getSession } from '../platform/roster'
import { KillSwitch } from './KillSwitch'
import { LoopsPanel } from './LoopsPanel'

/** The off switches for the whole account, reached from /app/controls. */
export function ControlsPage() {
  const phone = getSession()?.phone || ''
  return (
    <div className="controls">
      <div className="container controls__inner">
        <Link to="/app" className="controls__back">
          ← Back
        </Link>
        <h1>Controls</h1>
        <p className="controls__lead">Stop every hire at once, or pause one loop.</p>
        <KillSwitch phone={phone} />
        <LoopsPanel phone={phone} />
      </div>
    </div>
  )
}
