import { useState, useEffect, useCallback } from 'react'
import type { FeatureAuth } from './FeatureMiniApps'
import './approvePurchase.css'

interface SpendDetails {
  ok: boolean
  id?: string
  merchant?: string
  purpose?: string
  amount_cents?: number
  amount?: string
  status?: string
  url?: string
  image?: string
  subtotal?: string
  tax?: string
  shipping?: string
  already_approved?: boolean
  finalization_status?: string
  approval_url?: string
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

  const searchParams = new URLSearchParams(window.location.search)
  const id =
    spendId ||
    searchParams.get('id') ||
    searchParams.get('spend') ||
    ''

  const paramItem =
    searchParams.get('item') ||
    searchParams.get('title') ||
    searchParams.get('purpose') ||
    ''
  const paramAmount =
    searchParams.get('amount') ||
    searchParams.get('price') ||
    ''
  const paramMerchant =
    searchParams.get('merchant') ||
    (searchParams.get('url') ? (() => { try { return new URL(searchParams.get('url')!).hostname.replace(/^www\./, '') } catch { return '' } })() : '')
  const paramUrl = searchParams.get('url') || ''
  const paramImage = searchParams.get('image') || searchParams.get('img') || ''
  const paramSubtotal = searchParams.get('subtotal') || ''
  const paramTax = searchParams.get('tax') || ''
  const paramShipping = searchParams.get('shipping') || ''

  const load = useCallback(() => {
    const fallbackDetails: SpendDetails = {
      ok: true,
      id,
      merchant: paramMerchant || undefined,
      purpose: paramItem || undefined,
      amount: paramAmount ? (paramAmount.startsWith('$') ? paramAmount : `$${Number(paramAmount).toFixed(2)}`) : undefined,
      url: paramUrl || undefined,
      status: 'pending',
    }

    if (!id) {
      setError('No verified purchase request was provided. No payment credential was created.')
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    fetch(`/api/payments/spend/approve?id=${encodeURIComponent(id)}&format=json`)
      .then((res) => res.json())
      .then((data: SpendDetails) => {
        if (!data.ok || !data.amount) {
          setError(data.error || 'This purchase request was not found in the payment gateway. No charge was created.')
        } else {
          setDetails({
            ...fallbackDetails,
            ...data,
            merchant: data.merchant || fallbackDetails.merchant,
            purpose: data.purpose || fallbackDetails.purpose,
            amount: data.amount || fallbackDetails.amount,
          })
          if (data.already_approved) setApproved(true)
        }
      })
      .catch(() => {
        setError('Could not verify spend request with payment gateway.')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [id, paramMerchant, paramItem, paramAmount, paramUrl])

  useEffect(() => {
    load()
  }, [load])

  function handleApprove() {
    if (busy || approved) return
    setError(null)
    if (!id || id.startsWith('req_local_') || !details?.approval_url) {
      setError('This order has not been staged with Link. No payment credential was created.')
      return
    }
    setBusy(true)
    window.location.href = details.approval_url
  }

  if (loading) {
    return (
      <div className="ap-container" style={{ textAlign: 'center', padding: '40px 0' }}>
        <p style={{ color: '#71717a', fontSize: '14px' }}>Loading checkout…</p>
      </div>
    )
  }

  if (error && !details) {
    return (
      <div className="ap-container" style={{ textAlign: 'center', padding: '40px 0' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#ff453a' }}>Unavailable</h2>
        <p style={{ color: '#71717a', fontSize: '13px' }}>{error}</p>
      </div>
    )
  }

  const merchant = details?.merchant || paramMerchant
  const purpose = details?.purpose || paramItem
  const amount = details?.amount || (paramAmount ? (paramAmount.startsWith('$') ? paramAmount : `$${Number(paramAmount).toFixed(2)}`) : '')
  const productUrl = details?.url || paramUrl
  const imageUrl = details?.image || paramImage
  const subtotal = details?.subtotal || paramSubtotal
  const shippingDisplay = details?.shipping || paramShipping
  const taxDisplay = details?.tax || paramTax
  const hasBreakdown = Boolean(subtotal || shippingDisplay || taxDisplay)
  const orderConfirmed = details?.finalization_status === 'completed'

  if (!merchant || !purpose || !amount) {
    return (
      <div className="ap-container" style={{ textAlign: 'center', padding: '40px 0' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#ff453a' }}>Could not verify checkout</h2>
        <p style={{ color: '#71717a', fontSize: '13px' }}>Merchant, item, and exact total are required before Link approval.</p>
      </div>
    )
  }

  return (
    <div className="ap-container">
      {/* Header */}
      <div className="ap-header">
        <div className="ap-merchant-badge">
          <span className="ap-merchant-dot" />
          <span>{merchant}</span>
        </div>
        <h1 className="ap-hero-price">{amount}</h1>
        <div className="ap-hero-sub">One-time approval &bull; Link by Stripe</div>
      </div>

      {/* Grouped Inset: Items in Order */}
      <div className="ap-group">
        <div className="ap-row">
          <div className="ap-item-media">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={purpose}
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '10px' }}
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none'
                }}
              />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <path d="M16 10a4 4 0 0 1-8 0" />
              </svg>
            )}
          </div>
          <div className="ap-item-content">
            <div className="ap-item-name">{purpose}</div>
            <div className="ap-item-meta">
              {productUrl ? (
                <a
                  href={productUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#a1a1aa', textDecoration: 'none' }}
                >
                  View item on {merchant} ↗
                </a>
              ) : (
                `Verified on ${merchant}`
              )}
            </div>
          </div>
          <div className="ap-item-price">{amount}</div>
        </div>

        {hasBreakdown && (
          <div className="ap-breakdown">
            {subtotal && <div className="ap-breakdown-row"><span>Subtotal</span><span>{subtotal}</span></div>}
            {shippingDisplay && (
              <div className="ap-breakdown-row">
                <span>Shipping</span>
                <span style={{ color: shippingDisplay.toLowerCase() === 'free' ? '#30d158' : undefined, fontWeight: 500 }}>{shippingDisplay}</span>
              </div>
            )}
            {taxDisplay && <div className="ap-breakdown-row"><span>Tax</span><span>{taxDisplay}</span></div>}
            <div className="ap-breakdown-row ap-total"><span>Exact total</span><span>{amount}</span></div>
          </div>
        )}
      </div>

      {/* Grouped Inset: Payment Method */}
      <div className="ap-group">
        <div className="ap-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div className="ap-item-media" style={{ width: '38px', height: '38px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                <line x1="1" y1="10" x2="23" y2="10" />
              </svg>
            </div>
            <div>
              <div className="ap-row-label">Payment Method</div>
              <div className="ap-row-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>Link by Stripe</span>
                <span className="ap-payment-brand">LINK</span>
              </div>
              <div className="ap-row-sub" style={{ fontSize: '12px' }}>
                One-time credential &bull; issued only after approval
              </div>
            </div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'rgba(255,69,58,0.12)', border: '1px solid rgba(255,69,58,0.25)', color: '#ff453a', fontSize: '13px' }}>
          {error}
        </div>
      )}

      {/* Action / Confirmed State */}
      {approved ? (
        <div className="ap-confirmed-card">
          <div className="ap-confirmed-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <div className="ap-confirmed-title">{orderConfirmed ? 'Order Confirmed' : 'Payment Approved'}</div>
          <p className="ap-confirmed-desc">
            {orderConfirmed
              ? `The merchant confirmed your order for ${purpose}.`
              : `Alpha is continuing the live merchant checkout for ${purpose}.`}
          </p>
          <p style={{ fontSize: '12px', color: '#71717a', margin: 0 }}>
            {orderConfirmed
              ? 'Alpha sent the merchant confirmation to your iMessage thread.'
              : 'The merchant confirmation number will arrive in iMessage after checkout completes.'}
          </p>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className="ap-pay-button"
            disabled={busy}
            onClick={() => void handleApprove()}
          >
            {busy ? (
              'Processing…'
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14h2v2h-2v-2zm0-10h2v8h-2V6z" />
                </svg>
                <span>Review {amount} in Link</span>
              </>
            )}
          </button>
          <div className="ap-security-note">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>Merchant and total are locked to this one approval</span>
          </div>
        </div>
      )}
    </div>
  )
}
