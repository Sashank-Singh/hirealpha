import { useEffect, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { ALPHA_LINE, alphaThreadHref, formatAlphaLine, useAlphaLine } from './alphaLine'
import { apiSetupStatus } from './api'
import { getSession } from './roster'
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
 * no second call to action: the wizard is done and the only next step is the
 * thread. The line under the button is the user's OWN Alpha number, read from
 * Photon — never a house number, because every account gets its own.
 *
 * Shown ONCE: the flag is written when they tap, and anyone who comes back to
 * this URL afterwards goes straight to the platform.
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
      {/* The bubble is a stadium plus a triangle. Drawn as one path the tail
       * rounds off into a nub; two overlapping white shapes union into the
       * pointed tail the real mark has. */}
      <rect x="8.5" y="12.5" width="47" height="35" rx="17.5" fill="#ffffff" />
      <path d="M15 40.5 L9.5 55 L28 45.5 Z" fill="#ffffff" />
    </svg>
  )
}

/* The sentence above the button is a claim about a message that may not exist,
 * so it is read from the server rather than assumed. `/api/setup/status` reports
 * `welcomed` — true only when the onboard_done welcome was actually sent.
 *
 * Live, 2026-09-21: the founder finished onboarding and read "Alpha already
 * texted you" while Alpha had not texted at all. The friend log says why —
 * "[friend] intro to +12163032166 failed: [spectrum-imessage] Target not allowed
 * for this project" — and the screen had no idea. It does now, and it says the
 * true thing in both states instead of a warm thing in one. */
type Welcome = 'sent' | 'not-yet' | 'unknown'

function welcomeLine(state: Welcome, line: string): string {
  const shown = formatAlphaLine(line)
  if (state === 'sent') return `Alpha already texted you from ${shown}. Pick it up there.`
  if (state === 'not-yet') return `Alpha texts you from ${shown} — tap and say hi, it answers in seconds.`
  return `Alpha replies from ${shown}. Open the thread to start.`
}

export function TextAlphaPage() {
  const [params] = useSearchParams()
  const [done, setDone] = useState(false)
  const [welcome, setWelcome] = useState<Welcome>('unknown')
  const line = useAlphaLine()

  useEffect(() => {
    const email = getSession()?.email
    if (!email) return
    let cancelled = false
    void apiSetupStatus({ persona: 'friend', email })
      .then((s) => {
        if (!cancelled) setWelcome(s.welcomed ? 'sent' : 'not-yet')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

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
        <p className="textalpha__lead">{welcomeLine(welcome, line)}</p>
        <a
          className="textalpha__btn"
          // "Hey, Alpha!" rides along only when Alpha has not texted first: a
          // thread that already exists is opened clean, and a first message gets
          // written for them. Founder's rule, 2026-09-21, verbatim.
          href={alphaThreadHref(line, { greet: welcome !== 'sent' })}
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
        {line !== ALPHA_LINE && <p className="textalpha__line">{formatAlphaLine(line)}</p>}
      </div>
    </main>
  )
}
