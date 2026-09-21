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
 * The thread with Alpha, opened CLEAN — no draft typed into the composer.
 *
 * The founder's correction, 2026-09-20, verbatim: the button "just takes to the
 * thread not start a new message — takes to iMessage thread with Alpha since it
 * already texted me first during onboarding."
 *
 * Verified on macOS by opening both forms with Messages quit: `sms:<line>&body=…`
 * opens the thread with "Hey, Alpha!" already typed into the compose box — that
 * is what starting a new message looks like — while `sms:<line>` opens the same
 * thread with the field empty. Every caller here is returning to a conversation
 * Alpha opened first, so none of them should pre-write the person's words.
 */
export function alphaThreadHref(phone: string = ALPHA_LINE): string {
  return `sms:${phone || ALPHA_LINE}`
}

/** `+14155951440` → `(415) 595-1440`, the way a phone shows it. */
export function formatAlphaLine(phone: string): string {
  const digits = String(phone || '').replace(/[^\d]/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (ten.length !== 10) return phone
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
}

/**
 * This user's own Alpha line, from Photon, with the default until it lands. One
 * request per mount; a failure leaves the default in place rather than a broken
 * link, because a tappable wrong-ish number beats no button at all.
 */
export function useAlphaLine(): string {
  const [line, setLine] = useState(ALPHA_LINE)
  useEffect(() => {
    const phone = getSession()?.phone
    void apiAssignedPhone(phone)
      .then((assigned) => {
        if (assigned) setLine(assigned)
      })
      .catch(() => undefined)
  }, [])
  return line
}
