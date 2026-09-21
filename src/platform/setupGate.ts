/* Whether the menu card shows the onboarding wizard or the home grid.
 *
 * Three signals decide it, in this order, and the order is the whole point:
 *
 *  1. A finished wizard stays finished. `ha_setup_done`/`ha_setup_done_<email>`
 *     is a local mirror of the server row, so a failed status read or a done
 *     POST that raced a stale token can never re-open the wizard.
 *  2. A wizard still IN FLIGHT is not a finished setup, whatever the server's
 *     auto-detect says. The status endpoint calls setup done once two of four
 *     step-writes exist (nutrition goals, mini prefs, a person, a saved place),
 *     which is already true by the time someone reaches the last page — the
 *     connectors. So connecting Gmail mid-wizard returned them to a gate that
 *     read "done" and dropped them on the mini-app home grid instead of the
 *     connect page they had just left. Founder, 2026-09-20, verbatim: "I
 *     connected Gmail and it took me to this page, which is the homepage of
 *     miniapps. It should not do that." `ha_setup_step` is written on every Next
 *     and cleared on Done and on sign out, so its presence means mid-wizard and
 *     nothing else.
 *  3. Otherwise the server answers, and `null` means "ask it".
 *
 * Pure on purpose: the localStorage reads happen at the call site, and the
 * decision is testable without a DOM.
 */

export type SetupGateInput = {
  /** `ha_setup_done_<email>`, or `ha_setup_done` when there is no email. */
  localDone: string | null
  /** `ha_setup_step` — the step the wizard is resuming on, or null. */
  stepInFlight: string | null
  /** What /api/setup/status answered, or null before it has. */
  serverDone: boolean | null
}

/** true = home grid, false = wizard, null = the server has not answered yet. */
export function setupIsDone({ localDone, stepInFlight, serverDone }: SetupGateInput): boolean | null {
  if (localDone === 'friend') return true
  if (stepInFlight) return false
  return serverDone
}
