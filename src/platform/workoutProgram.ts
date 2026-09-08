export type WorkoutPlace = 'home' | 'gym'
export type WorkoutWeekday = 1 | 2 | 3 | 4 | 5
/** Any weekday: JS day indexes, 0 = Sunday ... 6 = Saturday. */
export type WorkoutDay = 0 | 1 | 2 | 3 | 4 | 5 | 6
export type WorkoutMoveCount = 4 | 5 | 6

export type WorkoutMove = {
  name: string
  sets: number
  reps: number
  restSec: number
  defaultMode?: 'reps' | 'time'
  targetSec?: number
  cue?: string
}

export type WorkoutSession = {
  weekday: WorkoutDay
  dayLabel: string
  name: string
  moves: WorkoutMove[]
}

export const WORKOUT_PLACE_KEY = 'hire.workout.place'
export const WORKOUT_MOVE_COUNT_KEY = 'hire.workout.moves'

export const WORKOUT_WEEKDAYS: WorkoutWeekday[] = [1, 2, 3, 4, 5]

export const WORKOUT_DAY_LETTERS: Record<WorkoutWeekday, string> = {
  1: 'M',
  2: 'T',
  3: 'W',
  4: 'T',
  5: 'F',
}

export const WORKOUT_DAY_LABELS: Record<WorkoutWeekday, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
}

export const WORKOUT_DAYS_KEY = 'hire.workout.days'
export const DEFAULT_WORKOUT_DAYS: WorkoutDay[] = [1, 2, 3, 4, 5]

export const WORKOUT_DAY_LETTERS_ALL: Record<WorkoutDay, string> = {
  0: 'S',
  1: 'M',
  2: 'T',
  3: 'W',
  4: 'T',
  5: 'F',
  6: 'S',
}

export const WORKOUT_DAY_LABELS_ALL: Record<WorkoutDay, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
}

const GYM: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Push',
    moves: [
      { name: 'Bench press', sets: 4, reps: 6, restSec: 120, cue: 'Retract shoulder blades, plant feet firmly, control the descent.' },
      { name: 'Overhead press', sets: 3, reps: 8, restSec: 90, cue: 'Squeeze glutes and core tight, press straight overhead.' },
      { name: 'Incline dumbbell press', sets: 3, reps: 10, restSec: 75, cue: 'Drive through upper chest, full stretch at the bottom.' },
      { name: 'Lateral raise', sets: 3, reps: 12, restSec: 60, cue: 'Lead with elbows, slight forward lean, pause at the apex.' },
      { name: 'Tricep pushdown', sets: 3, reps: 12, restSec: 60, cue: 'Pin elbows to your ribs, fully lock out triceps at bottom.' },
      { name: 'Cable fly', sets: 3, reps: 12, restSec: 60, cue: 'Keep slight bend in elbows, hug an imaginary barrel.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Pull',
    moves: [
      { name: 'Barbell row', sets: 4, reps: 6, restSec: 120, cue: 'Hinge at hips with flat back, pull bar to lower ribcage.' },
      { name: 'Lat pulldown', sets: 3, reps: 8, restSec: 90, cue: 'Pull elbows down toward back pockets, chest proud.' },
      { name: 'Seated cable row', sets: 3, reps: 10, restSec: 75, cue: 'Keep torso upright, drive elbows back and squeeze lats.' },
      { name: 'Dumbbell curl', sets: 3, reps: 10, restSec: 60, cue: 'Strict form, supinate wrists at the top for peak bicep squeeze.' },
      { name: 'Face pull', sets: 3, reps: 12, restSec: 60, cue: 'Pull rope toward eye level, externally rotating shoulders.' },
      { name: 'Hammer curl', sets: 3, reps: 10, restSec: 60, cue: 'Neutral grip throughout, builds brachialis and forearms.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Legs',
    moves: [
      { name: 'Back squat', sets: 4, reps: 6, restSec: 150, cue: 'Brace core 360 degrees, sit deep between hips, drive floor away.' },
      { name: 'Romanian deadlift', sets: 3, reps: 8, restSec: 120, cue: 'Soft knees, push hips back until hamstrings stretch loaded.' },
      { name: 'Leg press', sets: 3, reps: 10, restSec: 90, cue: 'Feet shoulder-width, lower smoothly without rounding lower back.' },
      { name: 'Leg extension', sets: 3, reps: 12, restSec: 60, cue: 'Pause 1s at full extension to burn the quads.' },
      { name: 'Leg curl', sets: 3, reps: 12, restSec: 60, cue: 'Curl heels tightly to glutes, keep hips pinned down.' },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 60, cue: 'Full stretch at bottom, rise high onto balls of feet.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Upper',
    moves: [
      { name: 'Incline bench', sets: 4, reps: 8, restSec: 90, cue: 'Focus on clavicular head of chest, controlled negative.' },
      { name: 'Chest supported row', sets: 4, reps: 8, restSec: 90, cue: 'Chest glued to pad, squeeze mid-back and rhomboids.' },
      { name: 'Seated dumbbell press', sets: 3, reps: 10, restSec: 75, cue: 'Elbows slightly tucked, press smoothly upward.' },
      { name: 'Pull ups', sets: 3, reps: 8, restSec: 90, cue: 'Full dead-hang stretch to chin over bar with no kipping.' },
      { name: 'Lateral raise', sets: 3, reps: 12, restSec: 60, cue: 'Controlled tempo, focus tension on side delts.' },
      { name: 'Tricep pushdown', sets: 3, reps: 12, restSec: 60, cue: 'Keep upper arms motionless, isolate the triceps.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Lower',
    moves: [
      { name: 'Deadlift', sets: 3, reps: 5, restSec: 180, cue: 'Engage lats, wedge hips into bar, push floor away.' },
      { name: 'Bulgarian split squat', sets: 3, reps: 8, restSec: 90, cue: 'Rear foot elevated, sink deep into front hip and heel.' },
      { name: 'Romanian deadlift', sets: 3, reps: 8, restSec: 90, cue: 'Keep dumbbells tight to shins, feel deep hamstring load.' },
      { name: 'Walking lunge', sets: 3, reps: 10, restSec: 75, cue: 'Long strides, keep chest tall, smooth continuous rhythm.' },
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Curl pelvis up toward chest to activate lower abs.' },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45, cue: '2s pause at top squeeze, 2s deep heel stretch.' },
    ],
  },
}

const HOME: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Push & Core',
    moves: [
      { name: 'Push ups', sets: 4, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Body in a straight plank, elbows 45 degrees, chest touches floor.' },
      { name: 'Pike push ups', sets: 3, reps: 8, restSec: 60, defaultMode: 'reps', targetSec: 40, cue: 'Hips high in V shape, lower crown of head between hands.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 16, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Widen feet, lock hips to eliminate rocking while tapping.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Peel chest off floor using spine erectors, open shoulders.' },
      { name: 'Diamond push ups', sets: 3, reps: 8, restSec: 60, defaultMode: 'reps', targetSec: 40, cue: 'Thumbs and index fingers touch, tricep overload.' },
      { name: 'Plank', sets: 3, reps: 30, restSec: 45, defaultMode: 'time', targetSec: 30, cue: 'Squeeze glutes, tuck pelvis, push floor through forearms.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Pull & Posterior',
    moves: [
      { name: 'Superman', sets: 4, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Lift chest and quads together, hold 2s squeeze at apex.' },
      { name: 'Glute bridge', sets: 4, reps: 15, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Drive through heels, squeeze glutes hard at the top.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 35, cue: 'Hands behind head, articulate spine smoothly upward.' },
      { name: 'Glute kickback', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'From all fours, drive sole of foot toward ceiling.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Smooth thoracic extension, breathe deep into diaphragm.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 16, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Lock core like iron, zero torso sway.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Legs & Power',
    moves: [
      { name: 'Squat', sets: 4, reps: 15, restSec: 60, defaultMode: 'reps', targetSec: 60, cue: 'Knees track over toes, break parallel, chest upright.' },
      { name: 'Reverse lunge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Step back softly, 90 degree angles at both knees, drive front heel.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Power hips to ceiling, hold full glute extension.' },
      { name: 'Jump squat', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 30, cue: 'Explode up off the ground, land softly bending knees.' },
      { name: 'Split squat', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Static stance, lower straight down into front hip.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'High rise on tiptoes, slow eccentric lower.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Upper & Athletic',
    moves: [
      { name: 'Hindu push ups', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Swoop chest down and through into cobra, reverse back to pike.' },
      { name: 'Superman', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Posterior chain recruitment, lengthen body from fingers to toes.' },
      { name: 'Wide push ups', sets: 3, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Hands 1.5x shoulder width, stretches outer chest.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Target upper erectors and postural stabilizers.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 16, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Keep core engaged like a steel plank.' },
      { name: 'Plank', sets: 3, reps: 40, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Tuck chin, maintain maximum tension throughout core.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Lower & Conditioning',
    moves: [
      { name: 'Walking lunge', sets: 3, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 60, cue: 'Smooth stride, tap back knee lightly, continuous tension.' },
      { name: 'Single leg glute bridge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'One leg extended straight, drive floor away with active heel.' },
      { name: 'Reverse lunge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Alternating backward steps with upright torso.' },
      { name: 'Split squat', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Lower straight into front heel, isolate quadriceps.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Slow controlled 2s raise and 2s lowering.' },
      { name: 'Glute kickback', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Target upper glute without over-arching lumbar spine.' },
    ],
  },
}

export type WorkoutCategory = 'strength' | 'calisthenics' | 'hiit' | 'legs' | 'core_mobility'

export type WorkoutCategoryMeta = {
  id: WorkoutCategory
  name: string
  shortLabel: string
  blurb: string
}

export const WORKOUT_CATEGORIES: WorkoutCategoryMeta[] = [
  { id: 'strength', name: 'Strength & Muscle', shortLabel: 'Strength', blurb: 'Heavy compound lifts & progressive overload' },
  { id: 'calisthenics', name: 'Calisthenics & Bodyweight', shortLabel: 'Calisthenics', blurb: 'Pure bodyweight strength, control & endurance' },
  { id: 'hiit', name: 'HIIT & Fat Burn', shortLabel: 'HIIT & Burn', blurb: 'High-intensity interval conditioning & cardio' },
  { id: 'legs', name: 'Legs & Glutes', shortLabel: 'Legs & Glutes', blurb: 'Quads, hamstrings, calves & glute drive' },
  { id: 'core_mobility', name: 'Core & Mobility', shortLabel: 'Core & Posture', blurb: 'Spine resilience, stability & full posture' },
]

export const WORKOUT_CATEGORY_KEY = 'hire.workout.category'

/* ---------------- Home Category Splits ---------------- */
const HOME_CALISTHENICS: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Push & Stability',
    moves: [
      { name: 'Push ups', sets: 4, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Full range push up with rigid hollow body.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 16, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Anti-rotational stability, wide base.' },
      { name: 'Squat', sets: 3, reps: 15, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Bodyweight deep squats, track knees with toes.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Smooth thoracic spine activation.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Drive heels through floor for peak contraction.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Diaphragm breathing and spine decompression.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Posterior & Core',
    moves: [
      { name: 'Superman', sets: 4, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Hold 2-second squeeze at top apex.' },
      { name: 'Glute kickback', sets: 3, reps: 14, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Drive heel to ceiling, keep lumbar neutral.' },
      { name: 'Single leg glute bridge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Isolate each glute without hip dip.' },
      { name: 'Plank', sets: 3, reps: 40, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Full body isometric core tension.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Pause 1s at top, controlled lowering.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Open shoulders and chest.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Explosive Bodyweight',
    moves: [
      { name: 'Jump squat', sets: 4, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 35, cue: 'Explosive triple extension, soft quiet landing.' },
      { name: 'Pike push ups', sets: 3, reps: 8, restSec: 60, defaultMode: 'reps', targetSec: 40, cue: 'Vertical pushing mechanics for shoulder power.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 18, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'High-rep core stabilization.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Fast lockout with sustained squeeze.' },
      { name: 'Reverse lunge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Power out of the front heel.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Maximum hollow body core hold.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Upper Body Control',
    moves: [
      { name: 'Wide push ups', sets: 3, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Wide chest stretch with controlled negative.' },
      { name: 'Diamond push ups', sets: 3, reps: 8, restSec: 60, defaultMode: 'reps', targetSec: 40, cue: 'Tricep close-grip overload.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Strengthen erector chain.' },
      { name: 'Split squat', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Unilateral quad balance and depth.' },
      { name: 'Superman', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Long reach forward and backward.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Gentle spinal extension recovery.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Full Calisthenics Flow',
    moves: [
      { name: 'Hindu push ups', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Fluid dive-bomber swoop and press.' },
      { name: 'Walking lunge', sets: 3, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 60, cue: 'Smooth rhythmic locomotive strides.' },
      { name: 'Single leg glute bridge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Pelvic symmetry and glute drive.' },
      { name: 'Plank', sets: 3, reps: 50, restSec: 45, defaultMode: 'time', targetSec: 50, cue: 'Finishing endurance core plank.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Tiptoe balance with slow descent.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Upper back posture correction.' },
    ],
  },
}

const HOME_HIIT: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Metabolic Push & Core',
    moves: [
      { name: 'Jump squat', sets: 4, reps: 15, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Explode off the ground, land softly into squat.' },
      { name: 'Push ups', sets: 4, reps: 12, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Fast rhythmic tempo, maintain rigid plank line.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 20, restSec: 30, defaultMode: 'time', targetSec: 40, cue: 'Brace core tightly to prevent hip sway.' },
      { name: 'Reverse lunge', sets: 3, reps: 14, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Continuous fluid strides, heart rate elevated.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Active recovery breath, extend upper spine.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Maximum full-body isometric tension.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Cardio & Posterior',
    moves: [
      { name: 'Jump squat', sets: 4, reps: 15, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Powerful triple extension at ankles, knees, hips.' },
      { name: 'Superman', sets: 4, reps: 14, restSec: 30, defaultMode: 'time', targetSec: 40, cue: 'Pulse reps to burn the posterior chain.' },
      { name: 'Glute bridge', sets: 3, reps: 20, restSec: 30, defaultMode: 'reps', targetSec: 40, cue: 'High-rep glute burn with rapid hip lockouts.' },
      { name: 'Split squat', sets: 3, reps: 12, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Quick turnaround, drive off front mid-foot.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 20, restSec: 30, defaultMode: 'time', targetSec: 45, cue: 'Steady anti-rotational core pump.' },
      { name: 'Plank', sets: 3, reps: 40, restSec: 30, defaultMode: 'time', targetSec: 40, cue: 'Breathe steadily while bracing against fatigue.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Lower Engine HIIT',
    moves: [
      { name: 'Squat', sets: 4, reps: 20, restSec: 45, defaultMode: 'time', targetSec: 50, cue: 'Speed squats with full range of motion.' },
      { name: 'Jump squat', sets: 4, reps: 12, restSec: 45, defaultMode: 'time', targetSec: 35, cue: 'Spring off the toes with explosive power.' },
      { name: 'Reverse lunge', sets: 3, reps: 14, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Dynamic alternating steps backward.' },
      { name: 'Walking lunge', sets: 3, reps: 14, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Continuous locomotive burn.' },
      { name: 'Calf raise', sets: 3, reps: 25, restSec: 30, defaultMode: 'reps', targetSec: 40, cue: 'Quick bouncy reps to fire calves.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Lock in core after lower body demand.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Upper & Core Burn',
    moves: [
      { name: 'Hindu push ups', sets: 4, reps: 10, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Dynamic flowing dive-bomber reps.' },
      { name: 'Jump squat', sets: 3, reps: 15, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Interval cardio spike between pushes.' },
      { name: 'Wide push ups', sets: 3, reps: 12, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Deep outer chest stretch and pump.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 30, defaultMode: 'time', targetSec: 35, cue: 'Upper back and erector engagement.' },
      { name: 'Diamond push ups', sets: 3, reps: 8, restSec: 45, defaultMode: 'time', targetSec: 35, cue: 'Tricep conditioning burnout.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 30, defaultMode: 'time', targetSec: 45, cue: 'Solid hollow-body hold to finish.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Total Body Shred',
    moves: [
      { name: 'Jump squat', sets: 4, reps: 15, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Maximum vertical effort on each rep.' },
      { name: 'Push ups', sets: 4, reps: 12, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Steady rhythmic push tempo.' },
      { name: 'Single leg glute bridge', sets: 3, reps: 12, restSec: 30, defaultMode: 'time', targetSec: 40, cue: 'Drive through the active heel.' },
      { name: 'Walking lunge', sets: 3, reps: 14, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Long locomotive lunges across room.' },
      { name: 'Superman', sets: 3, reps: 14, restSec: 30, defaultMode: 'time', targetSec: 35, cue: 'Final posterior chain effort.' },
      { name: 'Plank', sets: 3, reps: 60, restSec: 45, defaultMode: 'time', targetSec: 60, cue: 'Endurance champion: 60s iron plank.' },
    ],
  },
}

const HOME_LEGS: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Quad & Glute Drive',
    moves: [
      { name: 'Squat', sets: 4, reps: 15, restSec: 60, defaultMode: 'reps', targetSec: 50, cue: 'Sit deep between hips, power through mid-foot.' },
      { name: 'Reverse lunge', sets: 3, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Step back softly, drive through front heel.' },
      { name: 'Glute bridge', sets: 4, reps: 16, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Hard glute contraction at lockout.' },
      { name: 'Single leg glute bridge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 40, cue: 'Isolate each side to balance glute power.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Slow controlled 2s pause at top squeeze.' },
      { name: 'Glute kickback', sets: 3, reps: 14, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Target upper glute with neutral spine.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Hamstring & Posterior',
    moves: [
      { name: 'Split squat', sets: 4, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Drop back knee toward floor, load front quad & hip.' },
      { name: 'Glute kickback', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Drive sole of shoe toward ceiling.' },
      { name: 'Glute bridge', sets: 4, reps: 15, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Full hip extension, squeeze glutes at apex.' },
      { name: 'Walking lunge', sets: 3, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 60, cue: 'Long strides for glute and hamstring bias.' },
      { name: 'Superman', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Strengthen entire posterior kinetic chain.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'High rise on tiptoes, slow eccentric drop.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Unilateral & Plyo',
    moves: [
      { name: 'Jump squat', sets: 4, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 35, cue: 'Explosive spring from full squat depth.' },
      { name: 'Split squat', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Stay tall, keep front heel firmly planted.' },
      { name: 'Single leg glute bridge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 40, cue: 'Level pelvis, no hip rotation.' },
      { name: 'Reverse lunge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Smooth backward step, 90° bend at both knees.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Full stretch at bottom, strong calf squeeze.' },
      { name: 'Glute kickback', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Controlled lift, pause 1s at apex.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Glute Hypertrophy',
    moves: [
      { name: 'Glute bridge', sets: 4, reps: 18, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'High-rep burner, hold each rep 1 second at top.' },
      { name: 'Single leg glute bridge', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 40, cue: 'Unilateral glute motor unit recruitment.' },
      { name: 'Squat', sets: 4, reps: 15, restSec: 60, defaultMode: 'reps', targetSec: 50, cue: 'Break parallel, keep chest proud.' },
      { name: 'Walking lunge', sets: 3, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 60, cue: 'Continuous lunging with upright spine.' },
      { name: 'Glute kickback', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Squeeze upper glute pocket.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Controlled tempo, burn out the calves.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Lower Burnout',
    moves: [
      { name: 'Squat', sets: 4, reps: 16, restSec: 60, defaultMode: 'reps', targetSec: 50, cue: 'Deep clean reps, maximum quad fatigue.' },
      { name: 'Jump squat', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 35, cue: 'Final explosive plyometric burst.' },
      { name: 'Reverse lunge', sets: 3, reps: 12, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Steady rhythm, deep knee bends.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Drive from heels, lock hips high.' },
      { name: 'Split squat', sets: 3, reps: 10, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Burn out remaining unilateral reserves.' },
      { name: 'Calf raise', sets: 3, reps: 25, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Endurance pump set on the calves.' },
    ],
  },
}

const HOME_CORE_MOBILITY: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Anti-Rotation & Anterior',
    moves: [
      { name: 'Plank', sets: 4, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Lock ribcage to pelvis, squeeze glutes.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Resist all rotational torque through torso.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Chest opening, reverse slouch posture.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Articulate thoracic vertebrae with control.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Activate glutes to unload the lumbar spine.' },
      { name: 'Superman', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Strengthen the posterior erector sheath.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Spine Health & Decompression',
    moves: [
      { name: 'Superman', sets: 4, reps: 12, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Strengthen entire erector spinae sheath.' },
      { name: 'Back extension', sets: 3, reps: 14, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Slow smooth cadence, zero jerking.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Open collarbones, breathe into diaphragm.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Level pelvis, full hip extension.' },
      { name: 'Glute kickback', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Glute medius and maximus motor control.' },
      { name: 'Plank', sets: 3, reps: 40, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Solid 40-second hollow core brace.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Pelvic Stability & Balance',
    moves: [
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Neutral spine, drive from heels.' },
      { name: 'Single leg glute bridge', sets: 3, reps: 10, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Level hips, no dipping on the free side.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 16, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Wide stable foot stance, quiet hips.' },
      { name: 'Glute kickback', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Strict glute recruitment without lumbar arch.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Restorative thoracic extension.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Push floor away through active serratus.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Torso Strength',
    moves: [
      { name: 'Plank', sets: 4, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Lock abs, glutes and quads together.' },
      { name: 'Superman', sets: 3, reps: 14, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Long reach forward and backward.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Mid-back thoracic focus.' },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Chest proud, pull shoulder blades together.' },
      { name: 'Plank shoulder taps', sets: 3, reps: 20, restSec: 45, defaultMode: 'reps', targetSec: 45, cue: 'Anti-rotation core brace.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Posterior chain recruitment.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Full Mobility Flow',
    moves: [
      { name: 'Cobra', sets: 3, reps: 12, restSec: 30, defaultMode: 'reps', targetSec: 30, cue: 'Restorative spinal extension.' },
      { name: 'Superman', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Activate back postural chain.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Fluid spinal mobility.' },
      { name: 'Single leg glute bridge', sets: 3, reps: 10, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Fix hip asymmetries.' },
      { name: 'Glute kickback', sets: 3, reps: 12, restSec: 45, defaultMode: 'reps', targetSec: 40, cue: 'Target glute medius and hip stabilizers.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Clean finishing core brace.' },
    ],
  },
}

/* ---------------- Gym Category Splits ---------------- */
const GYM_CALISTHENICS: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Gym Calisthenics & Cables',
    moves: [
      { name: 'Pull ups', sets: 4, reps: 8, restSec: 90, cue: 'Full dead hang to chin over bar, strict form.' },
      { name: 'Push ups', sets: 4, reps: 15, restSec: 60, defaultMode: 'reps', targetSec: 45, cue: 'Clean floor push ups with full chest touch.' },
      { name: 'Cable fly', sets: 3, reps: 12, restSec: 60, cue: 'Squeeze inner chest, slight bend in elbows.' },
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Curl pelvis up toward ribcage, avoid swinging.' },
      { name: 'Tricep pushdown', sets: 3, reps: 12, restSec: 60, cue: 'Lock out triceps with pin-point control.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Rigid body line to finish upper workout.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Lower Power & Calisthenics',
    moves: [
      { name: 'Bulgarian split squat', sets: 4, reps: 8, restSec: 90, cue: 'Elevate back foot, sink deep into front hip.' },
      { name: 'Jump squat', sets: 3, reps: 10, restSec: 60, cue: 'Explosive vertical jump, soft controlled landing.' },
      { name: 'Romanian deadlift', sets: 3, reps: 8, restSec: 90, cue: 'Hinge back deeply to load hamstrings.' },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45, cue: 'Full range of motion, rise high on balls of feet.' },
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Core anterior brace and grip endurance.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 60, cue: 'Terminal hip lockout for glute burn.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Shoulders & Bodyweight',
    moves: [
      { name: 'Pike push ups', sets: 3, reps: 8, restSec: 75, cue: 'Overhead pressing simulation, lower head between hands.' },
      { name: 'Pull ups', sets: 3, reps: 8, restSec: 90, cue: 'Pronated grip, pull chest to bar.' },
      { name: 'Lateral raise', sets: 3, reps: 12, restSec: 60, cue: 'Lead with elbows, pause 1s at parallel.' },
      { name: 'Face pull', sets: 3, reps: 12, restSec: 60, cue: 'External rotation, pull rope to eye level.' },
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Strict pelvic tuck to burn lower abs.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Solid serratus push-away hold.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Athletic Legs',
    moves: [
      { name: 'Back squat', sets: 4, reps: 8, restSec: 120, cue: 'Drive out of the hole, knees tracking over toes.' },
      { name: 'Walking lunge', sets: 3, reps: 12, restSec: 75, cue: 'Dynamic continuous strides across gym floor.' },
      { name: 'Split squat', sets: 3, reps: 10, restSec: 60, cue: 'Unilateral quad endurance and depth.' },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45, cue: 'Explosive rise, deliberate 2s lowering.' },
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Engage abs and stabilize hips.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 60, cue: 'Deep glute burn finisher.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Pull & Core Mastery',
    moves: [
      { name: 'Pull ups', sets: 4, reps: 8, restSec: 90, cue: 'Wide grip pull ups, squeeze lats hard at top.' },
      { name: 'Seated cable row', sets: 3, reps: 10, restSec: 75, cue: 'Drive elbows back, proud chest.' },
      { name: 'Push ups', sets: 3, reps: 15, restSec: 60, cue: 'Controlled horizontal push finisher.' },
      { name: 'Dumbbell curl', sets: 3, reps: 10, restSec: 60, cue: 'Strict supinated bicep curls.' },
      { name: 'Hammer curl', sets: 3, reps: 10, restSec: 60, cue: 'Neutral grip for forearm and brachialis density.' },
      { name: 'Plank', sets: 3, reps: 60, restSec: 45, defaultMode: 'time', targetSec: 60, cue: 'Maximum tension 60s finisher.' },
    ],
  },
}

const GYM_HIIT: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Metabolic Weights Circuit',
    moves: [
      { name: 'Incline dumbbell press', sets: 4, reps: 10, restSec: 60, cue: 'Brisk controlled cadence, full stretch.' },
      { name: 'Jump squat', sets: 4, reps: 12, restSec: 45, cue: 'Plyometric interval between upper body sets.' },
      { name: 'Cable fly', sets: 3, reps: 12, restSec: 45, cue: 'Continuous tension on the chest.' },
      { name: 'Seated cable row', sets: 3, reps: 12, restSec: 45, cue: 'Rapid rhythmic rows with solid back brace.' },
      { name: 'Hanging knee raise', sets: 3, reps: 14, restSec: 45, cue: 'High-rep core conditioning.' },
      { name: 'Lateral raise', sets: 3, reps: 12, restSec: 45, cue: 'Side delt pump with zero swing.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Lower Burn Circuit',
    moves: [
      { name: 'Leg press', sets: 4, reps: 12, restSec: 60, cue: 'Smooth piston-like reps, no lockout at knees.' },
      { name: 'Walking lunge', sets: 3, reps: 14, restSec: 60, cue: 'Non-stop stride pace across gym floor.' },
      { name: 'Romanian deadlift', sets: 3, reps: 10, restSec: 60, cue: 'Hamstring loading with tight flat back.' },
      { name: 'Jump squat', sets: 3, reps: 10, restSec: 45, cue: 'Explosive legs finisher.' },
      { name: 'Leg extension', sets: 3, reps: 12, restSec: 45, cue: 'Constant quad tension.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 30, cue: 'Brisk calf pump.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Push-Pull HIIT',
    moves: [
      { name: 'Bench press', sets: 4, reps: 8, restSec: 60, cue: 'Explosive press off chest, controlled descent.' },
      { name: 'Barbell row', sets: 4, reps: 8, restSec: 60, cue: 'Pull bar firmly into naval.' },
      { name: 'Push ups', sets: 3, reps: 15, restSec: 45, cue: 'Rapid bodyweight push burner.' },
      { name: 'Lat pulldown', sets: 3, reps: 10, restSec: 45, cue: 'Drive elbows to pockets.' },
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Knees to chest, controlled drop.' },
      { name: 'Tricep pushdown', sets: 3, reps: 12, restSec: 45, cue: 'Fast pump sets on cables.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Lower Engine',
    moves: [
      { name: 'Back squat', sets: 4, reps: 8, restSec: 90, cue: 'Solid brace, quick power ascent.' },
      { name: 'Leg curl', sets: 3, reps: 12, restSec: 45, cue: 'Squeeze hamstrings tightly.' },
      { name: 'Bulgarian split squat', sets: 3, reps: 10, restSec: 60, cue: 'Unilateral leg stamina.' },
      { name: 'Leg press', sets: 3, reps: 15, restSec: 60, cue: 'High-rep quad exhaust.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 30, cue: 'Rapid calf burn.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, cue: 'Full terminal hip drive.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Full Body Blitz',
    moves: [
      { name: 'Deadlift', sets: 3, reps: 6, restSec: 90, cue: 'Total body power pull from floor.' },
      { name: 'Overhead press', sets: 3, reps: 8, restSec: 60, cue: 'Strict pressing power.' },
      { name: 'Walking lunge', sets: 3, reps: 12, restSec: 60, cue: 'Continuous movement rhythm.' },
      { name: 'Cable fly', sets: 3, reps: 12, restSec: 45, cue: 'Hug the imaginary barrel.' },
      { name: 'Dumbbell curl', sets: 3, reps: 10, restSec: 45, cue: 'Arms conditioning finish.' },
      { name: 'Plank', sets: 3, reps: 60, restSec: 45, defaultMode: 'time', targetSec: 60, cue: 'Full body iron plank lock.' },
    ],
  },
}

const GYM_LEGS: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Heavy Quad & Glute',
    moves: [
      { name: 'Back squat', sets: 4, reps: 8, restSec: 120, cue: 'Deep hip hinge, knees outward, power through whole foot.' },
      { name: 'Leg press', sets: 3, reps: 10, restSec: 90, cue: 'Feet high on platform for maximum glute recruitment.' },
      { name: 'Bulgarian split squat', sets: 3, reps: 10, restSec: 75, cue: 'Elevate rear foot, sink deep into front glute pocket.' },
      { name: 'Leg extension', sets: 3, reps: 12, restSec: 60, cue: 'Peak contraction quad squeeze at top.' },
      { name: 'Walking lunge', sets: 3, reps: 12, restSec: 60, cue: 'Drive through front heel, chest upright.' },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45, cue: 'Pause 2 seconds at the peak of each raise.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Hamstring & Posterior',
    moves: [
      { name: 'Romanian deadlift', sets: 4, reps: 8, restSec: 120, cue: 'Push hips backward until deep hamstring tension is reached.' },
      { name: 'Leg curl', sets: 4, reps: 12, restSec: 60, cue: 'Strict hamstring curls without lifting lower back.' },
      { name: 'Glute bridge', sets: 4, reps: 15, restSec: 60, cue: 'Drive hips up into complete terminal glute squeeze.' },
      { name: 'Bulgarian split squat', sets: 3, reps: 10, restSec: 75, cue: 'Unilateral glute & hamstring overload.' },
      { name: 'Hip abductor', sets: 3, reps: 15, restSec: 45, cue: 'Squeeze outer hips and hold 1s.' },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45, cue: 'Slow 3-second descent for stretch.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Unilateral Leg Power',
    moves: [
      { name: 'Bulgarian split squat', sets: 3, reps: 10, restSec: 90, cue: 'Load front leg heavily, upright posture.' },
      { name: 'Leg press', sets: 3, reps: 12, restSec: 75, cue: 'Single leg or standard leg press for volume.' },
      { name: 'Walking lunge', sets: 3, reps: 12, restSec: 60, cue: 'Continuous locomotion with knee drive.' },
      { name: 'Leg curl', sets: 3, reps: 12, restSec: 60, cue: 'Isolate hamstrings.' },
      { name: 'Glute kickback', sets: 3, reps: 15, restSec: 45, cue: 'Cable or machine glute kickback.' },
      { name: 'Calf raise', sets: 3, reps: 18, restSec: 45, cue: 'Explosive rise, deliberate slow descent.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Heavy Lower Compound',
    moves: [
      { name: 'Deadlift', sets: 4, reps: 5, restSec: 150, cue: 'Maximum total lower posterior power from floor.' },
      { name: 'Back squat', sets: 3, reps: 8, restSec: 120, cue: 'Solid braced core, break parallel with ease.' },
      { name: 'Romanian deadlift', sets: 3, reps: 8, restSec: 90, cue: 'Controlled descent, feel hamstrings stretch.' },
      { name: 'Leg press', sets: 3, reps: 12, restSec: 75, cue: 'Smooth pump sets to exhaust the quads.' },
      { name: 'Leg extension', sets: 3, reps: 12, restSec: 60, cue: 'Quad burn out finisher.' },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45, cue: 'Full range of motion ankle pump.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Glute Pump & Conditioning',
    moves: [
      { name: 'Glute bridge', sets: 4, reps: 16, restSec: 60, cue: 'Barbell or bodyweight hip extension finisher.' },
      { name: 'Romanian deadlift', sets: 3, reps: 10, restSec: 90, cue: 'Deep hamstring stretch and glute recruitment.' },
      { name: 'Leg curl', sets: 3, reps: 12, restSec: 60, cue: 'Strict knee flexion without swinging hips.' },
      { name: 'Hip abductor', sets: 3, reps: 15, restSec: 45, cue: 'Target upper glute medius.' },
      { name: 'Walking lunge', sets: 3, reps: 12, restSec: 60, cue: 'Strides to burn out remaining leg reserves.' },
      { name: 'Calf raise', sets: 3, reps: 20, restSec: 45, cue: 'Burnout set on the calves.' },
    ],
  },
}

const GYM_CORE_MOBILITY: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Spine & Core Strength',
    moves: [
      { name: 'Hanging knee raise', sets: 4, reps: 12, restSec: 45, cue: 'Posterior pelvic tilt to fire deep lower abs.' },
      { name: 'Face pull', sets: 3, reps: 15, restSec: 60, cue: 'External shoulder rotation for posture health.' },
      { name: 'Cable fly', sets: 3, reps: 12, restSec: 60, cue: 'Chest opening with controlled eccentric.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, cue: 'Articulate thoracic vertebrae with control.' },
      { name: 'Lat pulldown', sets: 3, reps: 10, restSec: 60, cue: 'Decompress spine, stretch lats at top.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Solid 45-second iron core brace.' },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Posterior Decompression',
    moves: [
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Hang freely from bar to decompress lower back.' },
      { name: 'Romanian deadlift', sets: 3, reps: 8, restSec: 90, cue: 'Gentle hamstring and posterior chain stretch.' },
      { name: 'Face pull', sets: 3, reps: 12, restSec: 60, cue: 'Pull rope toward eye level, separate thumbs.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, cue: 'Smooth spinal extension.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, cue: 'Activate glutes to unload the lumbar spine.' },
      { name: 'Plank', sets: 3, reps: 40, restSec: 45, defaultMode: 'time', targetSec: 40, cue: 'Lock in core stability.' },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Torso Resilience',
    moves: [
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Control the descent, zero swing.' },
      { name: 'Seated cable row', sets: 3, reps: 12, restSec: 60, cue: 'Retract shoulder blades, tall spine.' },
      { name: 'Lateral raise', sets: 3, reps: 12, restSec: 60, cue: 'Shoulder stability and posture balance.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, cue: 'Full range erector spinae control.' },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45, cue: 'Ankle mobility and plantar flexion.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Push floor away through active serratus.' },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Shoulder & Hip Mobility',
    moves: [
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Strict pelvic tuck to activate lower abs.' },
      { name: 'Incline dumbbell press', sets: 3, reps: 10, restSec: 60, cue: 'Deep stretch at bottom, open chest.' },
      { name: 'Face pull', sets: 3, reps: 15, restSec: 60, cue: 'Fix forward-shoulder computer posture.' },
      { name: 'Glute bridge', sets: 3, reps: 15, restSec: 45, cue: 'Open hip flexors at full extension.' },
      { name: 'Romanian deadlift', sets: 3, reps: 8, restSec: 90, cue: 'Slow 3-second descent for hamstring flexibility.' },
      { name: 'Plank', sets: 3, reps: 45, restSec: 45, defaultMode: 'time', targetSec: 45, cue: 'Solid full-body isometric tension.' },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Restorative Core',
    moves: [
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45, cue: 'Slow controlled knees to chest.' },
      { name: 'Barbell row', sets: 3, reps: 10, restSec: 60, cue: 'Reinforce strong thoracic posture.' },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 45, cue: 'Fluid spinal mobility.' },
      { name: 'Face pull', sets: 3, reps: 12, restSec: 60, cue: 'Rear delt and rotator cuff strengthener.' },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45, cue: 'Full ankle stretch on step edge.' },
      { name: 'Plank', sets: 3, reps: 50, restSec: 45, defaultMode: 'time', targetSec: 50, cue: 'Clean finishing core brace.' },
    ],
  },
}

export const WORKOUT_PROGRAM_MATRIX: Record<WorkoutPlace, Record<WorkoutCategory, Record<WorkoutWeekday, WorkoutSession>>> = {
  home: {
    strength: HOME,
    calisthenics: HOME_CALISTHENICS,
    hiit: HOME_HIIT,
    legs: HOME_LEGS,
    core_mobility: HOME_CORE_MOBILITY,
  },
  gym: {
    strength: GYM,
    calisthenics: GYM_CALISTHENICS,
    hiit: GYM_HIIT,
    legs: GYM_LEGS,
    core_mobility: GYM_CORE_MOBILITY,
  },
}

export const WORKOUT_PROGRAMS: Record<WorkoutPlace, Record<WorkoutWeekday, WorkoutSession>> = {
  home: HOME,
  gym: GYM,
}

export const WORKOUT_CATEGORY_PROGRAMS: Record<WorkoutCategory, Record<WorkoutWeekday, WorkoutSession>> = {
  strength: GYM,
  calisthenics: GYM_CALISTHENICS,
  hiit: GYM_HIIT,
  legs: GYM_LEGS,
  core_mobility: GYM_CORE_MOBILITY,
}

export function isWorkoutCategory(value: unknown): value is WorkoutCategory {
  return (
    value === 'strength' ||
    value === 'calisthenics' ||
    value === 'hiit' ||
    value === 'legs' ||
    value === 'core_mobility'
  )
}

export function readWorkoutCategory(): WorkoutCategory {
  try {
    const raw = localStorage.getItem(WORKOUT_CATEGORY_KEY)
    if (isWorkoutCategory(raw)) return raw
  } catch {
    /* ignore */
  }
  return 'strength'
}

export function writeWorkoutCategory(cat: WorkoutCategory) {
  try {
    localStorage.setItem(WORKOUT_CATEGORY_KEY, cat)
  } catch {
    /* ignore */
  }
}


export function isWorkoutPlace(value: string | null | undefined): value is WorkoutPlace {
  return value === 'home' || value === 'gym'
}

export function isWorkoutMoveCount(value: unknown): value is WorkoutMoveCount {
  return value === 4 || value === 5 || value === 6
}

export function isWorkoutWeekday(value: number): value is WorkoutWeekday {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5
}

export function isWorkoutDayLike(value: unknown): value is WorkoutDay {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6
}

export function jsDayToWeekday(jsDay: number): WorkoutWeekday | null {
  return isWorkoutWeekday(jsDay) ? jsDay : null
}

export function defaultWorkoutWeekday(now = new Date()): WorkoutWeekday {
  return jsDayToWeekday(now.getDay()) ?? 1
}

/** Default view: today when it is a workout day, otherwise the next enabled one. */
export function defaultWorkoutDay(days: WorkoutDay[], now = new Date()): WorkoutDay {
  const today = now.getDay() as WorkoutDay
  if (days.includes(today)) return today
  for (let i = 1; i <= 7; i++) {
    const d = ((today + i) % 7) as WorkoutDay
    if (days.includes(d)) return d
  }
  return 1
}

export function isWeekend(now = new Date()): boolean {
  const d = now.getDay()
  return d === 0 || d === 6
}

export function readWorkoutDays(): WorkoutDay[] {
  try {
    const raw = localStorage.getItem(WORKOUT_DAYS_KEY)
    if (!raw) return [...DEFAULT_WORKOUT_DAYS]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...DEFAULT_WORKOUT_DAYS]
    const days = [...new Set(parsed.filter(isWorkoutDayLike))].sort((a, b) => a - b)
    return days.length ? days : [...DEFAULT_WORKOUT_DAYS]
  } catch {
    return [...DEFAULT_WORKOUT_DAYS]
  }
}

export function writeWorkoutDays(days: WorkoutDay[]) {
  try {
    localStorage.setItem(WORKOUT_DAYS_KEY, JSON.stringify([...new Set(days)].sort((a, b) => a - b)))
  } catch {
    /* ignore */
  }
}

/** A session for any day of the week. Weekends reuse a weekday program:
 * Saturday runs Thursday's Upper, Sunday runs Friday's Lower. */
export function programFor(
  place: WorkoutPlace,
  day: WorkoutDay,
  category?: WorkoutCategory,
): WorkoutSession {
  const source: WorkoutWeekday = day === 6 ? 4 : day === 0 ? 5 : day
  const placeKey: WorkoutPlace = place === 'home' ? 'home' : 'gym'
  const catKey: WorkoutCategory = category && isWorkoutCategory(category) ? category : 'strength'
  const full = WORKOUT_PROGRAM_MATRIX[placeKey][catKey][source]
  return { ...full, weekday: day, dayLabel: WORKOUT_DAY_LABELS_ALL[day] }
}

export function workoutSession(
  place: WorkoutPlace,
  day: WorkoutDay,
  count: number = 4,
  category?: WorkoutCategory,
): WorkoutSession {
  const full = programFor(place, day, category)
  const n = isWorkoutMoveCount(count) ? count : 4
  return { ...full, moves: full.moves.slice(0, n) }
}

export function readWorkoutPlace(): WorkoutPlace {
  try {
    const raw = localStorage.getItem(WORKOUT_PLACE_KEY)
    if (isWorkoutPlace(raw)) return raw
  } catch {
    /* ignore */
  }
  return 'gym'
}

export function writeWorkoutPlace(place: WorkoutPlace) {
  try {
    localStorage.setItem(WORKOUT_PLACE_KEY, place)
  } catch {
    /* ignore */
  }
}

export function readWorkoutMoveCount(): WorkoutMoveCount {
  try {
    const n = Number(localStorage.getItem(WORKOUT_MOVE_COUNT_KEY))
    if (isWorkoutMoveCount(n)) return n
  } catch {
    /* ignore */
  }
  return 4
}

export function writeWorkoutMoveCount(count: WorkoutMoveCount) {
  try {
    localStorage.setItem(WORKOUT_MOVE_COUNT_KEY, String(count))
  } catch {
    /* ignore */
  }
}

export function restLabel(restSec: number): string {
  if (restSec >= 120 && restSec % 60 === 0) {
    const m = restSec / 60
    return `${m} minute${m === 1 ? '' : 's'} rest`
  }
  return `${restSec} seconds rest`
}

export function setsRepsLabel(sets: number, reps: number): string {
  return `${sets} set${sets === 1 ? '' : 's'} of ${reps} rep${reps === 1 ? '' : 's'}`
}

export function movePrescription(move: WorkoutMove, weight = 0): string {
  const lift = setsRepsLabel(move.sets, move.reps)
  const load = weight > 0 ? ` at ${weight} lbs` : ''
  return `${lift}${load}. ${restLabel(move.restSec)}`
}

export function formatTimerDisplay(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const mins = Math.floor(s / 60)
  const secs = s % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}


