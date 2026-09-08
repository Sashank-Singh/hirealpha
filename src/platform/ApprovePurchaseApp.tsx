import { useState, useEffect, useCallback } from 'react'
import type { FeatureAuth } from './FeatureMiniApps'

interface SpendDetails {
  ok: boolean
  id?: string
  merchant?: string
  purpose?: string
  amount_cents?: number
  amount?: string
  status?: string
  already_approved?: boolean
  error?: string
}

export function ApprovePurchaseApp({
  auth: _auth,
  spendId,
}: {
  auth: FeatureAuth
  spendId?: string
}) {
  const [details, setDetails] = useState<SpendDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approved, setApproved] = useState(false)

  const id =
    spendId ||
    new URLSearchParams(window.location.search).get('id') ||
    new URLSearchParams(window.location.search).get('spend') ||
    ''

  const load = useCallback(() => {
    if (!id) {
      setError('No purchase request specified.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    fetch(`/api/payments/spend/approve?id=${encodeURIComponent(id)}&format=json`)
      .then((res) => res.json())
      .then((data: SpendDetails) => {
        if (!data.ok && data.error) {
          setError(data.error)
        } else {
          setDetails(data)
          if (data.already_approved || data.status === 'consumed') {
            setApproved(true)
          }
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Could not load purchase details.')
      })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  async function handleApprove() {
    if (busy || !id || approved) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/payments/spend/approve?id=${encodeURIComponent(id)}&confirm=1&format=json`)
      const data = (await res.json()) as { ok?: boolean; error?: string; charged?: boolean; amount?: string }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Payment failed. Check your card details.')
      }
      setApproved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve payment.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="ma">
        <div className="ma-hero">
          <span className="ma-hero-kicker">Loading</span>
          <span className="ma-hero-num">…</span>
          <span className="ma-hero-label">Fetching purchase details</span>
        </div>
      </div>
    )
  }

  if (error && !details) {
    return (
      <div className="ma">
        <div className="ma-hero">
          <span className="ma-hero-kicker">Purchase</span>
          <span className="ma-hero-num" style={{ color: '#f85149' }}>Not Available</span>
          <span className="ma-hero-label">{error}</span>
        </div>
      </div>
    )
  }

  const merchant = details?.merchant || 'Merchant'
  const purpose = details?.purpose || 'Order'
  const amount = details?.amount || '$0.00'

  return (
    <div className="ma">
      <div className="ma-hero" style={{ borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.08))' }}>
        <span className="ma-hero-kicker" style={{ color: approved ? '#2ea043' : 'var(--mini-accent, #58a6ff)' }}>
          {approved ? '✓ Confirmed' : 'Purchase Approval'}
        </span>
        <span className="ma-hero-num">{amount}</span>
        <span className="ma-hero-label">{merchant}</span>
      </div>

      <div style={{ padding: '16px 0' }}>
        <div
          style={{
            background: 'var(--bg-card, rgba(255,255,255,0.04))',
            borderRadius: '16px',
            padding: '20px',
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
            marginBottom: '20px',
          }}
        >
          <div style={{ marginBottom: '14px' }}>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.6 }}>
              Item
            </span>
            <div style={{ fontSize: '16px', fontWeight: 600, marginTop: '2px' }}>{purpose}</div>
          </div>

          <div style={{ marginBottom: '14px' }}>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.6 }}>
              Merchant
            </span>
            <div style={{ fontSize: '15px', fontWeight: 500, marginTop: '2px' }}>{merchant}</div>
          </div>

          <div>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.6 }}>
              Payment Method
            </span>
            <div style={{ fontSize: '14px', opacity: 0.85, marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>💳 Connected card / Link wallet</span>
            </div>
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: '12px 16px',
              borderRadius: '12px',
              background: 'rgba(248, 81, 73, 0.15)',
              border: '1px solid rgba(248, 81, 73, 0.3)',
              color: '#f85149',
              fontSize: '14px',
              marginBottom: '16px',
            }}
          >
            {error}
          </div>
        )}

        {approved ? (
          <div
            style={{
              textAlign: 'center',
              padding: '24px 16px',
              background: 'rgba(46, 160, 67, 0.12)',
              borderRadius: '16px',
              border: '1px solid rgba(46, 160, 67, 0.3)',
            }}
          >
            <div style={{ fontSize: '36px', marginBottom: '8px' }}>✓</div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: '#3fb950', marginBottom: '4px' }}>
              Paid &amp; Approved!
            </div>
            <p style={{ fontSize: '13px', opacity: 0.75, margin: 0 }}>
              Alpha has confirmed your order in iMessage. You can close this sheet now.
            </p>
          </div>
        ) : (
          <button
            type="button"
            className="ma-btn ma-btn--block"
            disabled={busy}
            onClick={() => void handleApprove()}
            style={{
              background: '#238636',
              color: '#fff',
              fontSize: '16px',
              fontWeight: 600,
              padding: '16px',
              borderRadius: '14px',
              boxShadow: '0 4px 16px rgba(35, 134, 54, 0.3)',
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            {busy ? 'Processing…' : `Approve & Pay ${amount}`}
          </button>
        )}
      </div>
    </div>
  )
}
