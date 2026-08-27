import { useEffect, useState } from 'react'
import { toE164 } from './phone'

/** Three skip the line codes, minted for the phone that just joined. */
export function Invites({ phone }: { phone: string }) {
  const [codes, setCodes] = useState<string[]>([])
  const [copied, setCopied] = useState('')

  useEffect(() => {
    const e164 = toE164(phone)
    if (!e164) return
    let live = true
    fetch(`/api/invites/for-phone?phone=${encodeURIComponent(e164)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ codes?: string[] }>) : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (live && Array.isArray(data.codes)) setCodes(data.codes.slice(0, 3))
      })
      .catch(() => {
        // No codes yet, or the endpoint is not up. Quietly show nothing.
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
      window.setTimeout(() => setCopied(''), 1600)
    } catch {
      setCopied('')
    }
  }

  return (
    <div className="invites">
      <p className="invites__title">Invite 3 friends, they skip the line.</p>
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
