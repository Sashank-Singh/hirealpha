/** Deterministic weekly review copy. No hyphens or dashes. */

export type WeekSnap = {
  meals: number
  habitChecks: number
  sleepNights: number
  avgSleepHours: number
  workouts: number
  spend: number
  weeklyBudget: number
  followUpsDue: number
  gratitude: number
}

export function spendWouldBreakCap(weekTotal: number, weeklyBudget: number, amount: number) {
  if (!(weeklyBudget > 0) || !(amount > 0)) return false
  return weekTotal + amount > weeklyBudget + 0.009
}

export function composeWeekReview(snap: WeekSnap): {
  doneText: string
  slippedText: string
  focusText: string
  text: string
} {
  const doneBits = [
    snap.habitChecks ? `${snap.habitChecks} habit checks` : '',
    snap.workouts ? `${snap.workouts} workouts` : '',
    snap.meals ? `${snap.meals} meals` : '',
    snap.sleepNights ? `sleep ${snap.avgSleepHours}h across ${snap.sleepNights} nights` : '',
    snap.gratitude ? `${snap.gratitude} gratitude notes` : '',
  ].filter(Boolean)
  const doneText = doneBits.length ? `${doneBits.join('. ')}.` : 'Thin week. Few logs landed.'

  const slippedBits = [
    snap.followUpsDue > 0 ? `${snap.followUpsDue} follow ups still waiting` : '',
    snap.sleepNights > 0 && snap.avgSleepHours < 7 ? `Sleep averaged ${snap.avgSleepHours}h` : '',
    snap.habitChecks === 0 ? 'Habits went quiet' : '',
    snap.weeklyBudget > 0 && snap.spend > snap.weeklyBudget
      ? `Spend $${Math.round(snap.spend)} over the $${Math.round(snap.weeklyBudget)} cap`
      : '',
  ].filter(Boolean)
  const slippedText = slippedBits.length ? `${slippedBits.join('. ')}.` : 'Nothing loud slipped.'

  const focusText =
    snap.followUpsDue > 0
      ? 'One follow up, then stop.'
      : snap.sleepNights > 0 && snap.avgSleepHours < 7
        ? 'Protect sleep. One earlier night.'
        : snap.weeklyBudget > 0 && snap.spend > snap.weeklyBudget
          ? 'Hold spend until next week.'
          : 'Keep the same pace.'

  const spendLine =
    snap.weeklyBudget > 0 ? `Spend $${Math.round(snap.spend)} of $${Math.round(snap.weeklyBudget)}.` : ''
  const text = [
    'Week in review.',
    doneText,
    slippedText,
    `Next: ${focusText}`,
    spendLine,
    'This review is saved. Mail, texts, and calendar still need Send or Book. Money over the cap still needs a tap.',
  ]
    .filter(Boolean)
    .join(' ')

  return { doneText, slippedText, focusText, text }
}
