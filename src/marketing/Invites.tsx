import { useEffect, useState } from 'react'
import { toE164 } from './phone'
import { track } from '../track'

/** Three one-use codes, minted for the phone that just joined, made worth
 * sharing: every three friends who enter a code get one free month, recorded
 * server-side in hire_referral_rewards (the ledger; applying the credit at
 * checkout is a separate billing step, see README "Referral program"). */
export function Invites({ phone }: { phone: string }) {
  const [codes, setCodes] = useState<string[]>([])
  const [referrals, setReferrals] = useState(0)
  const [rewardEarned, setRewardEarned] = useState(false)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    const e164 = toE164(phone)
    if (!e164) return
    let live = true
    fetch(`/api/invites/for-phone?phone=${encodeURIComponent(e164)}`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{ codes?: string[]; referrals?: number; rewardEarned?: boolean }>)
          : Promise.reject(new Error(String(res.status))),
      )
      .then((data) => {
        if (!live) return
        if (Array.isArray(data.codes)) setCodes(data.codes.slice(0, 3))
        setReferrals(Number(data.referrals ?? 0))
        setRewardEarned(Boolean(data.rewardEarned))
      })
      .catch(() => {
        // No codes yet, or the endpoint is not up. Quietly show nothing.
      })
    return () => {
      live = false
    }
  }, [phone])

  if (codes.length === 0) return null

  const toNext = 3 - (referrals % 3)

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
      <p className="invites__title">
        {rewardEarned
          ? 'Free month earned — it is recorded on your number.'
          : `3 friends who hire Alpha = 1 free month. ${toNext} to go.`}
      </p>
      <p className="invites__sub">Share a code. A friend enters it at signup, you get the month.</p>
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
    </div>
  )
}
