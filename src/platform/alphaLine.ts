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

/** The thread composer, with a first line ready to send. */
export function alphaThreadHref(phone: string = ALPHA_LINE): string {
  return `sms:${phone || ALPHA_LINE}&body=Hey%2C%20Alpha!`
}
