import { useMemo, useState } from 'react'
import {
  CONNECTORS,
  loadConnectedIds,
  saveConnectedIds,
  type ConnectorId,
} from '../../data/connectors'
import './connectors.css'

export default function ConnectorsPage() {
  const [connected, setConnected] = useState<ConnectorId[]>(() => loadConnectedIds())
  const [busy, setBusy] = useState<ConnectorId | null>(null)

  const connectedSet = useMemo(() => new Set(connected), [connected])

  async function toggle(id: ConnectorId) {
    setBusy(id)
    await new Promise((r) => setTimeout(r, 500))
    setConnected((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      saveConnectedIds(next)
      return next
    })
    setBusy(null)
  }

  return (
    <div className="conn">
      <header className="conn__head">
        <div>
          <h1>Connectors</h1>
          <p>
            Plug tools into Alpha, Alpha (Coworker), and Alpha(CoFounder). Connect once, use across all three.
          </p>
        </div>
        <div className="conn__stat">
          <strong>{connected.length}</strong>
          <span>connected</span>
        </div>
      </header>

      <div className="conn__grid">
        {CONNECTORS.map((c) => {
          const on = connectedSet.has(c.id)
          return (
            <article key={c.id} className={`conn__card${on ? ' conn__card--on' : ''}`}>
              <div className="conn__icon">
                <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
                  <path fill={`#${c.icon.hex}`} d={c.icon.path} />
                </svg>
              </div>
              <div className="conn__body">
                <h2>{c.name}</h2>
                <p>{c.description}</p>
                <span className="conn__cat">{c.category}</span>
              </div>
              <button
                type="button"
                className={on ? 'btn btn--ghost' : 'btn btn--primary'}
                disabled={busy === c.id}
                onClick={() => toggle(c.id)}
              >
                {busy === c.id ? '…' : on ? 'Disconnect' : 'Connect'}
              </button>
            </article>
          )
        })}
      </div>
    </div>
  )
}
