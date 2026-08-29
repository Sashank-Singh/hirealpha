import { useEffect, useState } from 'react'
import { toE164 } from './phone'
import { track } from '../track'

/** Three one-use codes, minted for the phone that just joined. Each converted
 * code is one free month for the referrer, credited in hire_referral_credits
 * and applied automatically at their next checkout. */
export function Invites({ phone }: { phone: string }) {
  const [codes, setCodes] = useState<string[]>([])
  const [freeMonths, setFreeMonths] = useState<number | null>(null)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    const e164 = toE164(phone)
    if (!e164) return
    let live = true
    fetch(`/api/invites/for-phone?phone=${encodeURIComponent(e164)}`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{ codes?: string[] }>)
          : Promise.reject(new Error(String(res.status))),
      )
      .then((data) => {
        if (!live) return
        if (Array.isArray(data.codes)) setCodes(data.codes.slice(0, 3))
      })
      .catch(() => {
        // No codes yet, or the endpoint is not up. Quietly show nothing.
      })
    fetch(`/api/invites/status?phone=${encodeURIComponent(e164)}`)
      .then((res) =>
        res.ok ? (res.json() as Promise<{ freeMonths?: number }>) : Promise.reject(new Error(String(res.status))),
      )
      .then((data) => {
        if (!live) return
        setFreeMonths(Number(data.freeMonths ?? 0))
      })
      .catch(() => {
        // Balance unknown; the free-month line stays hidden.
      })
    return () => {
      live = false
    }
  }, [phone])

  if (codes.length === 0) return null


  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(code)
      track('invite_copied')
      window.setTimeout(() => setCopied(''), 1600)
    } catch {
      setCopied('')
    }
  }

  return (
    <div className="invites">
      <p className="invites__title">A friend who joins is a free month for you.</p>
      <p className="invites__sub">
        Share a code. It applies itself at your next checkout.
        {freeMonths !== null && freeMonths > 0
          ? ` ${freeMonths} free month${freeMonths === 1 ? '' : 's'} waiting.`
          : ''}
      </p>
      <div className="invites__row">
        {codes.map((code) => (
          <button
            key={code}
            type="button"
            className="invites__chip"
            aria-label={`Copy invite code ${code}`}
            onClick={() => void copy(code)}
          >
            {copied === code ? 'Copied' : code}
          </button>
        ))}
      </div>
      {freeMonths !== null && (
        <p className="invites__sub">
          {freeMonths > 0
            ? `${freeMonths} free month${freeMonths === 1 ? '' : 's'} earned. Applied at your next checkout.`
            : '0 so far. A friend joining earns you a free month.'}
        </p>
      )}
    </div>
  )
}
