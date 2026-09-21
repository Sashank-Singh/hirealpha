/* Alpha's line, and the `sms:` URL that opens the thread with it.
 *
 * `sms:` is what actually opens Messages — on iPhone and on the Mac — and it is
 * the scheme every Text Alpha button in this repo already uses. There is no
 * `imessage://` handler to call; iOS routes the Messages app through `sms:`.
 *
 * THE LINE IS PER USER. Photon assigns each person their own number, and the
 * founder's correction, 2026-09-21, verbatim: "alpha number is always diffrent for
 * users so it needs to make sure about the number from photon and show that number
 * not just a generic number its different for every user". The server already
 * answers that question — `GET /api/assigned-phone?phone=` reads the line Photon
 * gave this account, and `/api/contact/alpha.vcf` refuses to serve a card without
 * it. ALPHA_LINE below is only the last-resort default for a caller with no
 * session to ask about.
 */

import { useEffect, useState } from 'react'
import { apiAssignedPhone } from './api'
import { getSession } from './roster'

/** The default friend line, used only until the assigned one is known. */
export const ALPHA_LINE = '+14155951440'

/**
 * The thread with Alpha.
 *
 * A greeting is pre-typed ONLY when there is no message from Alpha to continue:
 * the founder's rule, 2026-09-21, verbatim — "makethe Text Alpha button have Hey,
 * Alpha! if you cannot text first". So the screen passes `greet: true` exactly
 * when the server says the welcome was not sent, and the person lands in the
 * composer with one tap's worth of work already done.
 *
 * Opened CLEAN otherwise, which was the earlier correction: the button "just
 * takes to the thread not start a new message — takes to iMessage thread with
 * Alpha since it already texted me first during onboarding." Verified on macOS by
 * opening both forms with Messages quit: `sms:<line>&body=…` opens the thread with
 * "Hey, Alpha!" already typed into the compose box, `sms:<line>` opens the same
 * thread with the field empty.
 */
export function alphaThreadHref(phone: string = ALPHA_LINE, opts: { greet?: boolean } = {}): string {
  const base = `sms:${phone || ALPHA_LINE}`
  return opts.greet ? `${base}&body=Hey%2C%20Alpha!` : base
}

/** `+14155951440` → `(415) 595-1440`, the way a phone shows it. */
export function formatAlphaLine(phone: string): string {
  const digits = String(phone || '').replace(/[^\d]/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (ten.length !== 10) return phone
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
}

/**
 * This user's own Alpha line, from Photon — `null` while Photon has not assigned
 * one.
 *
 * It is assigned asynchronously at signup (the server calls into Photon when it
 * queues the intro), so a person who races through onboarding can arrive here
 * before the line exists. Checked live, 2026-09-21, after the number was removed
 * from Photon: `{"assignedPhone":null}`. It retries a few times for that reason,
 * and a caller that still gets null must NOT show a house number — that is the
 * "generic number" the founder objected to, and it would point at somebody
 * else's thread.
 */
export function useAlphaLine(): string | null {
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    const phone = getSession()?.phone
    let cancelled = false
    let tries = 0
    const read = async () => {
      tries++
      const assigned = await apiAssignedPhone(phone).catch(() => null)
      if (cancelled) return
      if (assigned) {
        setLine(assigned)
        return
      }
      if (tries < 4) setTimeout(() => void read(), 4000)
    }
    void read()
    return () => {
      cancelled = true
    }
  }, [])
  return line
}
