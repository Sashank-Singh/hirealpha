/* Alpha's line, and the `sms:` URL that opens the thread with it.
 *
 * `sms:` is what actually opens Messages — on iPhone and on the Mac — and it is
 * the scheme every Text Alpha button in this repo already uses. There is no
 * `imessage://` handler to call; iOS routes the Messages app through `sms:`.
 *
 * The number itself is hardcoded in a handful of places (the workspace shell, the
 * dashboard, the landing page, the phone app). Those keep working; new callers
 * use this module so the post-onboarding path has one definition.
 */

/** Alpha's line for the friend persona. */
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
