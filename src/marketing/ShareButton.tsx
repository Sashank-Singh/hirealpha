import { useState } from 'react'

const SHARE_TEXT = 'I just hired an AI friend in iMessage. It texts first. hirealpha.chat'

/** Native share sheet where it exists, clipboard everywhere else. */
export function ShareButton() {
  const [copied, setCopied] = useState(false)

  async function share() {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text: SHARE_TEXT })
        return
      } catch {
        // The sheet was dismissed or refused. Copy still gives them the words.
      }
    }
    try {
      await navigator.clipboard.writeText(SHARE_TEXT)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button type="button" className="btn btn--ghost share-btn" onClick={() => void share()}>
      {copied ? 'Copied. Send it.' : 'Share Alpha'}
    </button>
  )
}
