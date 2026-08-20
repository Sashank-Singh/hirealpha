/** Self hosted demos in public/workout. v5 busts the 7 day static cache after bad stills. */
const DEMO_V = '5'

/** Self hosted demos in public/workout. GIFs from ExerciseDB where the lift matched. Two frame photos otherwise. */
export const EXERCISE_DEMO_MAP: Record<string, string> = {
  'push ups': `/workout/push-ups.gif?v=${DEMO_V}`,
  'pike push ups': `/workout/pike-to-cobra.gif?v=${DEMO_V}`,
  'diamond push ups': `/workout/diamond-push-ups.gif?v=${DEMO_V}`,
  'wide push ups': `/workout/wide-push-ups.gif?v=${DEMO_V}`,
  'hindu push ups': `/workout/hindu-push-ups.gif?v=${DEMO_V}`,
  'decline push ups': `/workout/decline-push-ups.gif?v=${DEMO_V}`,
  'superman': `/workout/superman.gif?v=${DEMO_V}`,
  'glute kickback': `/workout/glute-kickback.gif?v=${DEMO_V}`,
  'cobra': `/workout/cobra.gif?v=${DEMO_V}`,
  'back extension': `/workout/back-extension.gif?v=${DEMO_V}`,
  'glute bridge': `/workout/glute-bridge.gif?v=${DEMO_V}`,
  'plank': `/workout/plank.gif?v=${DEMO_V}`,
  'squat': `/workout/squat.gif?v=${DEMO_V}`,
  'reverse lunge': `/workout/reverse-lunge.gif?v=${DEMO_V}`,
  'jump squat': `/workout/jump-squats.gif?v=${DEMO_V}`,
  'calf raise': `/workout/standing-calf-raise.gif?v=${DEMO_V}`,
  'split squat': `/workout/split-squat.gif?v=${DEMO_V}`,
  'single leg glute bridge': `/workout/single-leg-glute-bridge.gif?v=${DEMO_V}`,
  'walking lunge': `/workout/walking-lunge.gif?v=${DEMO_V}`,
  'bench press': `/workout/bench-press.gif?v=${DEMO_V}`,
  'overhead press': `/workout/overhead-press.gif?v=${DEMO_V}`,
  'incline dumbbell press': `/workout/incline-dumbbell-press.gif?v=${DEMO_V}`,
  'tricep pushdown': `/workout/tricep-pushdown.gif?v=${DEMO_V}`,
  'lateral raise': `/workout/lateral-raise.gif?v=${DEMO_V}`,
  'cable fly': `/workout/cable-fly.gif?v=${DEMO_V}`,
  'barbell row': `/workout/barbell-row.gif?v=${DEMO_V}`,
  'lat pulldown': `/workout/lat-pulldown.gif?v=${DEMO_V}`,
  'seated cable row': `/workout/seated-cable-row.gif?v=${DEMO_V}`,
  'dumbbell curl': `/workout/dumbbell-curl.gif?v=${DEMO_V}`,
  'face pull': `/workout/face-pull.jpg?v=${DEMO_V}`,
  'hammer curl': `/workout/hammer-curl.gif?v=${DEMO_V}`,
  'back squat': `/workout/barbell-squat.gif?v=${DEMO_V}`,
  'romanian deadlift': `/workout/romanian-deadlift.gif?v=${DEMO_V}`,
  'leg press': `/workout/leg-press.jpg?v=${DEMO_V}`,
  'leg extension': `/workout/leg-extension.gif?v=${DEMO_V}`,
  'hanging knee raise': `/workout/hanging-knee-raise.jpg?v=${DEMO_V}`,
  'incline bench': `/workout/incline-bench.gif?v=${DEMO_V}`,
  'pull ups': `/workout/pull-ups.jpg?v=${DEMO_V}`,
  'seated dumbbell press': `/workout/seated-dumbbell-press.gif?v=${DEMO_V}`,
  'chest supported row': `/workout/chest-supported-row.gif?v=${DEMO_V}`,
  'deadlift': `/workout/deadlift.gif?v=${DEMO_V}`,
  'bulgarian split squat': `/workout/split-squat.gif?v=${DEMO_V}`,
  'leg curl': `/workout/leg-curl.gif?v=${DEMO_V}`,
  'hip abductor': `/workout/hip-abductor.jpg?v=${DEMO_V}`,
}

const DEMO_PACKED: Record<string, string> = {}
for (const [name, url] of Object.entries(EXERCISE_DEMO_MAP)) {
  DEMO_PACKED[name.replace(/ /g, '')] = url
}

export function normalizeLiftName(name: string): string {
  return name.toLowerCase().trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
}

export function exerciseDemoUrl(name: string): string | null {
  const n = normalizeLiftName(name)
  return EXERCISE_DEMO_MAP[n] ?? DEMO_PACKED[n.replace(/ /g, '')] ?? null
}
