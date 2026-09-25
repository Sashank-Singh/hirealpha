/* Route table for the concept prototypes.
 *
 * These live under `/lab/concept-*` rather than `/lab/email-v*` on purpose: a
 * second prototype set was authored in this same folder in parallel (see
 * `emailData.ts` / `LabNav.tsx` / `EmailV1NowWaitingLater.tsx`), and those paths
 * were already wired in src/App.tsx. Keeping a distinct prefix means both sets
 * render side by side and neither one silently replaces the other.
 */
export const LAB_ROUTES = {
  v1: '/lab/concept-1-now-waiting-later',
  v2: '/lab/concept-2-reply-queue',
  v3: '/lab/concept-3-brief-radar',
  compare: '/lab/concept-compare',
} as const
