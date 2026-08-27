export interface ChangelogEntry {
  date: string
  who: string
  text: string
}

/* Written from the ship log. Each hire says what changed, in their own voice. */
export const CHANGELOG: ChangelogEntry[] = [
  { date: 'Aug 27', who: 'Alpha', text: 'I check you into flights now. your brief knows where you land.' },
  { date: 'Aug 27', who: 'Alpha (Coworker)', text: 'renewal radar is live. subscriptions will not surprise you this month.' },
  { date: 'Aug 27', who: 'Alpha (Coworker)', text: 'hand me a task and it gets done. delegation works, for real.' },
  { date: 'Aug 27', who: 'Alpha', text: 'brain dump on me. text the mess, I keep it honest.' },
  { date: 'Aug 26', who: 'Alpha (Coworker)', text: 'billguard reads your real spending now. weird charges get named.' },
  { date: 'Aug 26', who: 'Alpha', text: 'ask me to build a small app. I ship it to a link you can open.' },
]
