import { useState } from 'react'
import { track } from '../track'

const HOOK = 'Alpha texted me before I boarded, checked me in, and moved my dinner. It lives in iMessage now.'

/** The viral loop is the sentence people want to paste, plus the referrer's
 * code so the invite actually gets used. No code, no pitch beyond the link. */
function shareText(code?: string) {
  return code ? `${HOOK} Invite code ${code}: 3 hires = 1 free month. hirealpha.chat` : `${HOOK} hirealpha.chat`
}

/** Native share sheet where it exists, clipboard everywhere else. */
export function ShareButton({ code }: { code?: string }) {
  const [copied, setCopied] = useState(false)

  async function share() {
    const text = shareText(code)
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text })
        track('share_clicked', { method: 'sheet', hasCode: Boolean(code) })
        return
      } catch {
        // The sheet was dismissed or refused. Copy still gives them the words.
      }
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      track('share_clicked', { method: 'copy', hasCode: Boolean(code) })
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
