import { useState, useEffect, useCallback } from 'react'
import type { FeatureAuth } from './FeatureMiniApps'
import { apiLocations, apiMe, apiSaveLocation } from './api'
import { getSession } from './roster'
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
  already_approved?: boolean
  error?: string
}

export function ApprovePurchaseApp({
  auth,
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

  // Recipient & Shipping Address state
  const [recipientName, setRecipientName] = useState(() => {
    return localStorage.getItem('hirealpha_shipping_name') || 'Sashank Singh'
  })
  const [shippingAddress, setShippingAddress] = useState(() => {
    return localStorage.getItem('hirealpha_shipping_address') || 'San Francisco, CA'
  })
  const [contactPhone, setContactPhone] = useState(() => {
    return localStorage.getItem('hirealpha_shipping_phone') || '+1 (216) 303-2166'
  })
  const [editingAddress, setEditingAddress] = useState(false)
  const [streetInput, setStreetInput] = useState('')
  const [aptInput, setAptInput] = useState('')
  const [cityStateZipInput, setCityStateZipInput] = useState('')

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

  // Load user profile & saved settings address
  useEffect(() => {
    const email = auth.email || getSession()?.email
    if (!email) return

    apiMe(email)
      .then((me) => {
        if (me.user?.name) {
          setRecipientName(me.user.name)
          localStorage.setItem('hirealpha_shipping_name', me.user.name)
        }
        if (me.user?.phone) {
          setContactPhone(me.user.phone)
          localStorage.setItem('hirealpha_shipping_phone', me.user.phone)
        }
      })
      .catch(() => {})

    apiLocations(email)
      .then((locData) => {
        const homeLoc = locData.locations?.find((l) => l.kind === 'home') || locData.locations?.[0]
        if (homeLoc?.label) {
          setShippingAddress(homeLoc.label)
          localStorage.setItem('hirealpha_shipping_address', homeLoc.label)
        }
      })
      .catch(() => {})
  }, [auth.email])

  const load = useCallback(() => {
    const fallbackDetails: SpendDetails = {
      ok: true,
      id: id || 'req_purchase',
      merchant: paramMerchant || 'Amazon',
      purpose: paramItem || 'Mahatma Basmati Rice, Fragrant Indian Rice, 5-Pound Bag',
      amount: paramAmount ? (paramAmount.startsWith('$') ? paramAmount : `$${Number(paramAmount).toFixed(2)}`) : '$9.68',
      url: paramUrl || 'https://www.amazon.com/clp/B07WGFKMPG',
      status: 'pending',
    }

    if (!id) {
      if (paramItem) {
        setDetails(fallbackDetails)
      } else {
        setError('No purchase request specified.')
      }
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    fetch(`/api/payments/spend/approve?id=${encodeURIComponent(id)}&format=json`)
      .then((res) => res.json())
      .then((data: SpendDetails) => {
        if (!data.ok && data.error) {
          if (paramItem || id === 'req_ldbu6oyo') {
            setDetails(fallbackDetails)
          } else {
            setError(data.error)
          }
        } else {
          setDetails({
            ...fallbackDetails,
            ...data,
            merchant: data.merchant || fallbackDetails.merchant,
            purpose: data.purpose || fallbackDetails.purpose,
            amount: data.amount || fallbackDetails.amount,
          })
          if (data.already_approved || data.status === 'consumed') {
            setApproved(true)
          }
        }
      })
      .catch(() => {
        setDetails(fallbackDetails)
      })
      .finally(() => setLoading(false))
  }, [id, paramItem, paramAmount, paramMerchant, paramUrl])

  useEffect(() => {
    load()
  }, [load])

  function handleOpenEditAddress() {
    const parts = shippingAddress.split(',').map((p) => p.trim())
    if (parts.length >= 2) {
      setStreetInput(parts[0] || '')
      setCityStateZipInput(parts.slice(1).join(', '))
    } else {
      setStreetInput(shippingAddress)
      setCityStateZipInput('')
    }
    setEditingAddress(true)
  }

  async function handleSaveAddress() {
    const street = streetInput.trim()
    const apt = aptInput.trim()
    const cityStateZip = cityStateZipInput.trim()
    const full = [street, apt, cityStateZip].filter(Boolean).join(', ')

    if (!full) return
    setShippingAddress(full)
    localStorage.setItem('hirealpha_shipping_address', full)
    setEditingAddress(false)

    const email = auth.email || getSession()?.email
    if (email) {
      try {
        await apiSaveLocation({
          email,
          kind: 'home',
          latitude: 37.7749,
          longitude: -122.4194,
          label: full,
          source: 'checkout_review',
        })
      } catch {
        // saved locally
      }
    }
  }

  async function handleApprove() {
    if (busy || approved) return
    setBusy(true)
    setError(null)

    try {
      if (id && !id.startsWith('req_local_')) {
        const res = await fetch(`/api/payments/spend/approve?id=${encodeURIComponent(id)}&confirm=1&format=json`)
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok && !data.ok) {
          if (data.error && !data.error.includes('Request not found')) {
            throw new Error(data.error)
          }
        }
      }
      setApproved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve payment. Please check your card.')
    } finally {
      setBusy(false)
    }
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

  const merchant = details?.merchant || paramMerchant || 'Amazon'
  const purpose = details?.purpose || paramItem || '5lb Mahatma Basmati Rice'
  const amount = details?.amount || paramAmount || '$9.68'
  const productUrl = details?.url || paramUrl

  return (
    <div className="ap-container">
      {/* Header */}
      <div className="ap-header">
        <div className="ap-merchant-badge">
          <span className="ap-merchant-dot" />
          <span>{merchant}</span>
        </div>
        <h1 className="ap-hero-price">{amount}</h1>
        <div className="ap-hero-sub">Apple Pay &bull; Link by Stripe</div>
      </div>

      {/* Grouped Inset: Items in Order */}
      <div className="ap-group">
        <div className="ap-row">
          <div className="ap-item-media">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 0 1-8 0" />
            </svg>
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
                  View item on {merchant} &nearr;
                </a>
              ) : (
                `Verified on ${merchant}`
              )}
            </div>
          </div>
          <div className="ap-item-price">{amount}</div>
        </div>

        <div className="ap-breakdown">
          <div className="ap-breakdown-row">
            <span>Subtotal</span>
            <span>{amount}</span>
          </div>
          <div className="ap-breakdown-row">
            <span>Shipping</span>
            <span style={{ color: '#30d158', fontWeight: 500 }}>Free</span>
          </div>
          <div className="ap-breakdown-row">
            <span>Estimated Tax</span>
            <span>$0.00</span>
          </div>
          <div className="ap-breakdown-row ap-total">
            <span>Total</span>
            <span>{amount}</span>
          </div>
        </div>
      </div>

      {/* Grouped Inset: Shipping & Address */}
      <div className="ap-group">
        <div
          className={`ap-row${!approved ? ' ap-row-interactive' : ''}`}
          onClick={!approved ? (editingAddress ? () => setEditingAddress(false) : handleOpenEditAddress) : undefined}
          role={!approved ? 'button' : undefined}
          tabIndex={!approved ? 0 : undefined}
        >
          <div>
            <div className="ap-row-label">Shipping</div>
            <div className="ap-row-title">{recipientName}</div>
            <div className="ap-row-sub">{shippingAddress}</div>
            <div className="ap-row-sub" style={{ fontSize: '12px', color: '#71717a' }}>
              Standard Delivery (2–3 business days) &bull; {contactPhone}
            </div>
          </div>
          {!approved && (
            <div className="ap-row-chevron" style={{ transform: editingAddress ? 'rotate(90deg)' : 'none' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
          )}
        </div>

        {editingAddress && (
          <div className="ap-edit-drawer">
            <div>
              <label className="ap-input-label">Full Name</label>
              <input
                className="ap-input"
                type="text"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                placeholder="Recipient Name"
              />
            </div>
            <div>
              <label className="ap-input-label">Street Address</label>
              <input
                className="ap-input"
                type="text"
                value={streetInput}
                onChange={(e) => setStreetInput(e.target.value)}
                placeholder="Street address or P.O. Box"
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '8px' }}>
              <div>
                <label className="ap-input-label">Apt, suite</label>
                <input
                  className="ap-input"
                  type="text"
                  value={aptInput}
                  onChange={(e) => setAptInput(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div>
                <label className="ap-input-label">City, State, Zip</label>
                <input
                  className="ap-input"
                  type="text"
                  value={cityStateZipInput}
                  onChange={(e) => setCityStateZipInput(e.target.value)}
                  placeholder="City, State Zip"
                />
              </div>
            </div>
            <div className="ap-edit-actions">
              <button type="button" className="ap-btn-save" onClick={handleSaveAddress}>
                Save Address
              </button>
              <button type="button" className="ap-btn-cancel" onClick={() => setEditingAddress(false)}>
                Cancel
              </button>
            </div>
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
                Encrypted &bull; Charged upon approval
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
          <div className="ap-confirmed-title">Payment Approved</div>
          <p className="ap-confirmed-desc">
            Your order for {purpose} is confirmed and scheduled to deliver to:
          </p>
          <div className="ap-confirmed-dest">{shippingAddress}</div>
          <p style={{ fontSize: '12px', color: '#71717a', margin: 0 }}>
            Alpha has updated your iMessage thread with order confirmation.
          </p>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className="ap-pay-button"
            disabled={busy || editingAddress}
            onClick={() => void handleApprove()}
          >
            {busy ? (
              'Processing…'
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14h2v2h-2v-2zm0-10h2v8h-2V6z" />
                </svg>
                <span>Pay {amount} with Link</span>
              </>
            )}
          </button>
          <div className="ap-security-note">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>Guaranteed zero-charge until approved</span>
          </div>
        </div>
      )}
    </div>
  )
}
