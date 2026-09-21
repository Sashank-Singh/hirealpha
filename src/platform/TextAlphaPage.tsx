import { useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { alphaThreadHref } from './alphaLine'
import './textAlpha.css'

/* The one screen after onboarding: Text Alpha.
 *
 * The founder's direction, verbatim, 2026-09-20: "after signup and onboarding it
 * takes me to homepage; it should show just one button, Text Alpha, with the
 * iMessage logo … make that return to iMessages, then open the contact that has
 * sent the message, creating a new message, but open the Alpha's chat so they
 * can continue from there."
 *
 * So this screen is deliberately one thing. No dashboard chrome, no app grid,
 * no second call to action: the wizard is done, the person's Alpha has already
 * texted them, and the only next step is the thread. Messages is where the
 * product actually lives, and the mini apps are reachable from there.
 *
 * Shown ONCE: the flag is written when they tap, and anyone who comes back to
 * this URL afterwards goes straight to the platform. That is the founder's
 * second instruction — "it only shows once. After that, they can access the
 * platform."
 */

/** The Messages mark: the green app icon with the white speech bubble. Drawn
 * inline so the screen ships no trademarked asset file and stays crisp at any
 * size. */
function MessagesMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Messages" focusable="false">
      <defs>
        <linearGradient id="ha-msg-green" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#67e06d" />
          <stop offset="100%" stopColor="#12ac2b" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14.5" fill="url(#ha-msg-green)" />
      <path
        d="M32 13.5c-12.4 0-22.4 7.7-22.4 17.2 0 5.5 3.4 10.4 8.6 13.6-.4 3.3-1.8 6.3-4.3 8.8-.5.5-.1 1.4.7 1.3 5.9-.6 10.6-2.4 13.9-4.5 1.2.1 2.4.2 3.5.2 12.4 0 22.4-7.7 22.4-17.2s-10-17.4-22.4-17.4z"
        fill="#ffffff"
      />
    </svg>
  )
}

export function TextAlphaPage() {
  const [params] = useSearchParams()
  const [done, setDone] = useState(false)
  let seen = false
  try {
    seen = localStorage.getItem('ha_text_alpha_seen') === '1'
  } catch {
    /* private mode: the screen is harmless to show more than once */
  }
  // `?again=1` re-opens it deliberately (a returning user who wants the link
  // again), without resetting the flag for everyone else.
  if (seen && params.get('again') !== '1' && !done) return <Navigate to="/app" replace />

  return (
    <main className="textalpha">
      <div className="textalpha__card">
        {/* One action, and the mark states the destination: the Messages icon is
         * the title, so the page needs no heading above the button. */}
        <MessagesMark size={56} />
        <p className="textalpha__lead">Alpha already texted you. Pick it up there.</p>
        <a
          className="textalpha__btn"
          href={alphaThreadHref()}
          onClick={() => {
            try {
              localStorage.setItem('ha_text_alpha_seen', '1')
            } catch {
              /* private mode */
            }
            setDone(true)
          }}
        >
          <MessagesMark size={22} />
          <span>Text Alpha</span>
        </a>
      </div>
    </main>
  )
}
