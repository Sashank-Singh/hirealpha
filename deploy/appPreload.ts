/** Match on-demand screen chunks so the HTML can start them before React boots.
 * These are code-only hints, never personalized data or authentication bypasses. */
export function appScreenChunk(pathname: string): string | null {
  if (pathname === '/app') return 'src/platform/SettingsSheet.tsx'
  const match = /^\/app\/mini\/(friend|coworker|cofounder)\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  const [, persona, kind] = match
  if (kind === 'home' || kind === 'apps') return `src/platform/${persona === 'friend' ? 'HomeApp' : 'WorkHomes'}.tsx`
  const groups: Record<string, string[]> = {
    FriendHubApps: ['body', 'later'],
    FeatureMiniApps: ['nutrition', 'habit_streak', 'mood_tracker', 'decision_ledger', 'drop_zone', 'meeting_mode', 'open_loops', 'relationship_radar', 'builds'],
    LifeMiniApps: ['workout_log', 'learning_queue', 'weekly_review', 'weekly_focus', 'networking_crm', 'sleep_tracker', 'pipeline_board', 'gratitude_journal', 'spending_snapshot'],
  }
  const module = Object.entries(groups).find(([, kinds]) => kinds.includes(kind!))?.[0]
  return module ? `src/platform/${module}.tsx` : null
}
