/** Plan names the billing endpoint expects, with the annual variant folded in. */
export function planFor(tier: 'free' | 'single' | 'bundle' | 'ultra', annual: boolean): string {
  return annual ? `${tier}-annual` : tier
}

/** Last reply time, short enough for a dot row. Empty when there is none yet. */
export function formatReply(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return ''
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return `${Math.round(ms / 1000)}s`
}

/** When a loop fires next, in words a text would use. */
export function nextRunLabel(nextRun: string | null, now: number): string {
  if (!nextRun) return ''
  const t = new Date(nextRun).getTime()
  if (Number.isNaN(t)) return ''
  const mins = Math.round((t - now) / 60000)
  if (mins <= 0) return 'runs now'
  if (mins < 60) return `runs in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `runs in ${hours}h`
  return `runs in ${Math.round(hours / 24)}d`
}
