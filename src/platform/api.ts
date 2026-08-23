import type { AgentId } from '../agents/types'
import type { ConnectorId } from './connectors'

const API = ''

function looksLikeHtml(text: string, res: Response) {
  const type = res.headers.get('content-type') || ''
  return type.includes('text/html') || /^\s*<!doctype html/i.test(text) || /^\s*<html[\s>]/i.test(text)
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (looksLikeHtml(text, res)) {
    throw new Error('Could not load this. Try again in a minute.')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Request failed (${res.status})`)
  }
}

export async function apiExchangeGoogle(ticket: string) {
  const res = await fetch(`${API}/api/auth/ticket?ticket=${encodeURIComponent(ticket)}`)
  const data = await parseJson<{ email?: string; name?: string | null; phone?: string | null; error?: string }>(res)
  if (!res.ok || !data.email) throw new Error(data.error || 'Google sign in failed')
  return { email: data.email, name: data.name || '', phone: data.phone || '' }
}

export async function apiSignIn(email: string, phone: string, name?: string, timezone?: string) {
  const res = await fetch(`${API}/api/me`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, phone, name, timezone }),
  })
  const data = await parseJson<{
    user?: { id: string; email: string; name: string | null; timezone: string | null; phone: string | null }
    roster?: AgentId[]
    error?: string
  }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not sign in')
  return data
}

export async function apiMe(email: string) {
  const res = await fetch(`${API}/api/me?email=${encodeURIComponent(email)}`)
  if (!res.ok) throw new Error('Could not load account')
  return parseJson<{
    user: { id: string; email: string; name: string | null; timezone: string | null; phone: string | null } | null
    roster: AgentId[]
    context: Partial<Record<AgentId, Record<string, string>>>
    connected: ConnectorId[]
    memory?: Partial<Record<AgentId, Array<{ key: string; value: string; durable: boolean }>>>
  }>(res)
}

export async function apiSavePhone(email: string, phone: string, name?: string, timezone?: string) {
  const res = await fetch(`${API}/api/me/phone`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, phone, name, timezone }),
  })
  const data = await parseJson<{ error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not save phone')
}

export type SavedLocation = {
  kind: 'current' | 'home' | 'work'
  latitude: number
  longitude: number
  accuracy_m: number | null
  label: string
  source: string | null
  updated_at: string
}

export async function apiLocations(email: string) {
  const res = await fetch(`${API}/api/me/locations?email=${encodeURIComponent(email)}`)
  if (!res.ok) throw new Error('Could not load locations')
  return parseJson<{ locations: SavedLocation[] }>(res)
}

export async function apiSaveLocation(input: {
  email: string
  kind: 'current' | 'home' | 'work'
  latitude: number
  longitude: number
  accuracy_m?: number | null
  label: string
  source?: string
}) {
  const res = await fetch(`${API}/api/me/locations/${input.kind}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: input.email,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy_m: input.accuracy_m ?? null,
      label: input.label,
      source: input.source || 'manual',
    }),
  })
  const data = await parseJson<{ locations?: SavedLocation[]; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not save location')
  return data.locations || []
}

export async function apiDeleteLocation(email: string, kind: 'current' | 'home' | 'work') {
  const qs = new URLSearchParams({ email })
  const res = await fetch(`${API}/api/me/locations/${kind}?${qs}`, { method: 'DELETE' })
  const data = await parseJson<{ locations?: SavedLocation[]; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not delete location')
  return data.locations || []
}

export async function apiSaveRoster(email: string, agentIds: AgentId[]) {
  const res = await fetch(`${API}/api/me/roster`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, agentIds }),
  })
  if (!res.ok) throw new Error('Could not save roster')
}

export async function apiSaveContext(email: string, agentId: AgentId, fields: Record<string, string>) {
  const res = await fetch(`${API}/api/me/hires/${agentId}/context`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fields }),
  })
  if (!res.ok) throw new Error('Could not save context')
}

export type HireMemory = { key: string; value: string; durable: boolean }

export async function apiHireMemory(email: string, agentId: AgentId) {
  const res = await fetch(`${API}/api/me/hires/${agentId}/memory?email=${encodeURIComponent(email)}`)
  if (!res.ok) throw new Error('Could not load memory')
  return parseJson<{ memories: HireMemory[] }>(res)
}

export async function apiSaveMemory(email: string, agentId: AgentId, facts: Array<{ key: string; value: string }>) {
  const res = await fetch(`${API}/api/me/hires/${agentId}/memory`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, facts }),
  })
  const data = await parseJson<{ memories?: HireMemory[]; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not save memory')
  return data.memories || []
}

export async function apiDeleteMemory(email: string, agentId: AgentId, key: string) {
  const qs = new URLSearchParams({ email, key })
  const res = await fetch(`${API}/api/me/hires/${agentId}/memory?${qs}`, { method: 'DELETE' })
  const data = await parseJson<{ memories?: HireMemory[]; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not delete memory')
  return data.memories || []
}

export async function apiConnectorStatus() {
  const res = await fetch(`${API}/api/connectors/status`)
  if (!res.ok) return { google: false, composio: false }
  return parseJson<{ google: boolean; composio: boolean }>(res)
}

export async function apiConnectUrl(input: {
  connector: ConnectorId
  email: string
  persona: AgentId
}) {
  const qs = new URLSearchParams({
    email: input.email,
    persona: input.persona,
    redirect: `/app/hires/${input.persona}`,
    json: '1',
  })
  const res = await fetch(`${API}/api/connect/${input.connector}?${qs}`)
  const data = await parseJson<{ url?: string; error?: string; message?: string }>(res)
  if (!res.ok || !data.url) {
    throw new Error(data.message || data.error || 'Connect is not configured yet')
  }
  return data.url
}

export async function apiSetup(input: {
  persona: AgentId
  feature?: string
  features?: string[]
  done?: boolean
  email?: string
  token?: string
}) {
  const res = await fetch(`${API}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      persona: input.persona,
      feature: input.feature,
      features: input.features,
      done: input.done,
      email: input.email,
      token: input.token,
    }),
  })
  const data = await parseJson<{
    ok?: boolean
    features?: string[]
    setup?: string[]
    setupDone?: boolean
    error?: string
    code?: string
  }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not set up that feature')
  return data
}

export async function apiSetupStatus(input: { persona: AgentId; email?: string; token?: string }) {
  const qs = new URLSearchParams({ persona: input.persona })
  if (input.token) qs.set('t', input.token)
  else if (input.email) qs.set('email', input.email)
  const res = await fetch(`${API}/api/setup/status?${qs}`)
  const data = await parseJson<{ setup?: string[]; setupDone?: boolean; error?: string; code?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not load setup')
  return { setup: data.setup || [], setupDone: !!data.setupDone }
}

/** Auth params shared by the feature mini-app endpoints. */
function authParams(input: { email?: string; token?: string }) {
  if (input.email) return { email: input.email }
  return { token: input.token }
}

function authQuery(a: { email?: string; token?: string; persona?: string }) {
  const qs = new URLSearchParams()
  if (a.email) qs.set('email', a.email)
  else if (a.token) qs.set('t', a.token)
  if (a.persona) qs.set('persona', a.persona)
  return qs
}

async function featurePost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await parseJson<T & { error?: string; code?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}

async function featureGet<T>(path: string, qs: URLSearchParams): Promise<T> {
  const res = await fetch(`${API}${path}?${qs}`)
  const data = await parseJson<T & { error?: string; code?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}

async function featurePatch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await parseJson<T & { error?: string; code?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}

export type OpenLoop = {
  id: string
  persona: string
  title: string
  context: string
  dueAt: string | null
  status: string
  createdAt: string
}

export const apiListLoops = (a: { email?: string; token?: string }) =>
  featureGet<{ loops: OpenLoop[] }>('/api/loops', authQuery(a))
export const apiAddLoop = (a: { email?: string; token?: string; persona?: string; title: string; context?: string; dueAt?: string }) =>
  featurePost<{ ok: boolean; id: string }>('/api/loops', { ...authParams(a), persona: a.persona, title: a.title, context: a.context, dueAt: a.dueAt })
export const apiPatchLoop = (a: { email?: string; token?: string; id: string; status: string; dueAt?: string }) =>
  featurePatch<{ ok: boolean }>(`/api/loops/${a.id}`, { ...authParams(a), status: a.status, dueAt: a.dueAt })

export type Decision = {
  id: string
  persona: string
  decision: string
  reason: string
  evidence: string
  owner: string
  reviewAt: string | null
  outcome: string | null
  status: string
  createdAt: string
}
export const apiListDecisions = (a: { email?: string; token?: string }) =>
  featureGet<{ decisions: Decision[] }>('/api/decisions', authQuery(a))
export const apiAddDecision = (a: {
  email?: string; token?: string; persona?: string; decision: string
  reason?: string; evidence?: string; owner?: string; reviewAt?: string
}) => featurePost<{ ok: boolean; id: string }>('/api/decisions', { ...authParams(a), persona: a.persona, decision: a.decision, reason: a.reason, evidence: a.evidence, owner: a.owner, reviewAt: a.reviewAt })
export const apiReviewDecision = (a: { email?: string; token?: string; id: string; outcome: string }) =>
  featurePatch<{ ok: boolean }>(`/api/decisions/${a.id}`, { ...authParams(a), outcome: a.outcome })

export type Relationship = {
  id: string
  name: string
  kind: string
  notes: string
  cadenceDays: number
  lastTouchAt: string | null
  updatedAt: string
}
export const apiListRelationships = (a: { email?: string; token?: string }) =>
  featureGet<{ relationships: Relationship[] }>('/api/relationships', authQuery(a))
export const apiAddRelationship = (a: { email?: string; token?: string; name: string; kind?: string; notes?: string; cadenceDays?: number }) =>
  featurePost<{ ok: boolean; id: string }>('/api/relationships', { ...authParams(a), name: a.name, kind: a.kind, notes: a.notes, cadenceDays: a.cadenceDays })
export const apiTouchRelationship = (a: { email?: string; token?: string; id: string }) =>
  featurePatch<{ ok: boolean }>(`/api/relationships/${a.id}`, { ...authParams(a), touch: true })

export type Drop = {
  id: string
  persona: string
  content: string
  mediaKind: string | null
  summary: string | null
  status: string
  createdAt: string
}
export const apiListDrops = (a: { email?: string; token?: string }) =>
  featureGet<{ drops: Drop[] }>('/api/dropzone', authQuery(a))
export const apiAddDrop = (a: { email?: string; token?: string; content: string; mediaKind?: string }) =>
  featurePost<{ ok: boolean; id: string }>('/api/dropzone', { ...authParams(a), content: a.content, mediaKind: a.mediaKind })
export const apiPatchDrop = (a: { email?: string; token?: string; id: string; status?: string; summary?: string }) =>
  featurePatch<{ ok: boolean }>(`/api/dropzone/${a.id}`, { ...authParams(a), status: a.status, summary: a.summary })

export type Meeting = {
  id: string
  title: string
  startsAt: string | null
  phase: string
  briefing: string | null
  notes: string | null
  followups: Array<{ decision?: string; owner?: string; action?: string }>
  createdAt: string
}
export const apiListMeetings = (a: { email?: string; token?: string }) =>
  featureGet<{ meetings: Meeting[] }>('/api/meetings', authQuery(a))
export const apiAddMeeting = (a: { email?: string; token?: string; title: string; startsAt?: string }) =>
  featurePost<{ ok: boolean; id: string }>('/api/meetings', { ...authParams(a), title: a.title, startsAt: a.startsAt })
export const apiPatchMeeting = (a: { email?: string; token?: string; id: string; phase?: string }) =>
  featurePatch<{ ok: boolean }>(`/api/meetings/${a.id}`, { ...authParams(a), phase: a.phase })
export const apiTranscribeMeeting = (a: {
  email?: string; token?: string; id: string; audioBase64: string; mimeType?: string
}) =>
  featurePost<{ ok: boolean; error?: string; transcript?: string }>(
    `/api/meetings/${a.id}/transcribe`,
    { ...authParams(a), audioBase64: a.audioBase64, mimeType: a.mimeType },
  )

export type NutritionLog = {
  id: string
  description: string
  imageUrl: string | null
  calories: number
  protein: number
  carbs: number
  fat: number
  eatenAt: string
}
export type NutritionGoals = { calorieGoal: number; proteinGoal: number; carbsGoal: number; fatGoal: number }
export const apiNutritionToday = (a: { email?: string; token?: string }) =>
  featureGet<{
    goals: NutritionGoals
    logs: NutritionLog[]
    history?: NutritionLog[]
    totals: { calories: number; protein: number; carbs: number; fat: number }
  }>('/api/nutrition', authQuery(a))
export const apiLogNutrition = (a: {
  email?: string; token?: string; description: string
  calories?: number; protein?: number; carbs?: number; fat?: number; imageUrl?: string
}) => featurePost<{ ok: boolean; id: string }>('/api/nutrition', { ...authParams(a), description: a.description, calories: a.calories, protein: a.protein, carbs: a.carbs, fat: a.fat, imageUrl: a.imageUrl })
export const apiSetNutritionGoals = (a: { email?: string; token?: string } & Partial<NutritionGoals>) => {
  return fetch(`${API}/api/nutrition/goals`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...authParams(a),
      calorieGoal: a.calorieGoal,
      proteinGoal: a.proteinGoal,
      carbsGoal: a.carbsGoal,
      fatGoal: a.fatGoal,
    }),
  }).then(async (res) => {
    const data = await parseJson<{ ok?: boolean; error?: string }>(res)
    if (!res.ok) throw new Error(data.error || 'Could not save goals')
    return data
  })
}
export const apiAnalyzeNutrition = (a: { email?: string; token?: string; description?: string; imageBase64?: string }) =>
  featurePost<{
    ok: boolean; needsKey?: boolean; calories?: number; protein?: number; carbs?: number; fat?: number
    guess?: string; error?: string
  }>('/api/nutrition/analyze', { ...authParams(a), description: a.description, imageBase64: a.imageBase64 })
export const apiLogNutritionPhoto = (a: {
  email?: string; token?: string; description?: string; imageBase64: string
}) =>
  featurePost<{
    ok: boolean; id: string; imageUrl?: string; estimated?: boolean; needsKey?: boolean; error?: string
  }>('/api/nutrition/photo', { ...authParams(a), description: a.description, imageBase64: a.imageBase64 })
export const apiDeleteNutritionLog = (a: { email?: string; token?: string; id: string }) =>
  featurePost<{ ok: boolean }>(`/api/nutrition/${a.id}`, { ...authParams(a), _delete: true })

/* ---- Habits ---- */
export type Habit = {
  id: string; name: string; emoji: string; createdAt: string
}
export type HabitLog = { id: string; habitId: string; date: string }
export const apiListHabits = (a: { email?: string; token?: string }) =>
  featureGet<{
    habits: (Habit & { streak: number; recentDays: string[]; logDates?: string[] })[]
    weekDays?: string[]
    weekStart?: string
  }>('/api/habits', authQuery(a))
export const apiAddHabit = (a: { email?: string; token?: string; name: string; emoji?: string }) =>
  featurePost<{ ok: boolean; id: string }>('/api/habits', { ...authParams(a), name: a.name, emoji: a.emoji })
export const apiToggleHabit = (a: { email?: string; token?: string; habitId: string; date: string }) =>
  featurePost<{ ok: boolean; done: boolean }>('/api/habits/toggle', { ...authParams(a), habitId: a.habitId, date: a.date })
export const apiDeleteHabit = (a: { email?: string; token?: string; habitId: string }) =>
  featurePost<{ ok: boolean }>(`/api/habits/${a.habitId}`, { ...authParams(a), _delete: true })

/* ---- Moods ---- */
export type MoodEntry = {
  id: string; emoji: string; energy: number; note: string | null; createdAt: string
}
export const apiListMoods = (a: { email?: string; token?: string }) =>
  featureGet<{ entries: MoodEntry[]; streak: number }>('/api/moods', authQuery(a))
export const apiLogMood = (a: { email?: string; token?: string; emoji: string; energy: number; note?: string }) =>
  featurePost<{ ok: boolean; id: string }>('/api/moods', { ...authParams(a), emoji: a.emoji, energy: a.energy, note: a.note })

/* ---- Workouts ---- */
export type WorkoutLog = {
  id: string; exercise: string; sets: number; reps: number; weight: number; notes: string | null; loggedAt: string
}
export type WorkoutPr = { exercise: string; weight: number; reps: number; loggedAt: string }
export const apiListWorkouts = (a: { email?: string; token?: string }) =>
  featureGet<{ logs: WorkoutLog[]; prs: WorkoutPr[]; workoutPlace?: 'home' | 'gym'; workoutMoveCount?: 4 | 5 | 6 }>(
    '/api/workouts',
    authQuery(a),
  )
export const apiLogWorkout = (a: {
  email?: string; token?: string; exercise: string; sets: number; reps: number; weight?: number; notes?: string
}) => featurePost<{ ok: boolean; id: string }>('/api/workouts', { ...authParams(a), exercise: a.exercise, sets: a.sets, reps: a.reps, weight: a.weight, notes: a.notes })
export const apiDeleteWorkout = (a: { email?: string; token?: string; id: string }) =>
  featurePost<{ ok: boolean }>(`/api/workouts/${a.id}`, { ...authParams(a), _delete: true })

/* ---- Learning queue ---- */
export type LearningItem = {
  id: string; title: string; url: string | null; kind: string; minutes: number; notes?: string | null; status: string; createdAt: string
}
export const apiListLearning = (a: { email?: string; token?: string }) =>
  featureGet<{ items: LearningItem[] }>('/api/learning', authQuery(a))
export const apiAddLearning = (a: {
  email?: string; token?: string; title: string; url?: string; kind?: string; minutes?: number; notes?: string
}) => featurePost<{ ok: boolean; id: string }>('/api/learning', { ...authParams(a), title: a.title, url: a.url, kind: a.kind, minutes: a.minutes, notes: a.notes })
export const apiPatchLearning = (a: { email?: string; token?: string; id: string; status?: string; _delete?: boolean }) =>
  featurePost<{ ok: boolean }>(`/api/learning/${a.id}`, { ...authParams(a), status: a.status, _delete: a._delete })

/* ---- Weekly review ---- */
export type WeeklySnapshot = {
  meals: number; calories: number; moodLogs: number; avgEnergy: number; habitChecks: number
  sleepNights: number; avgSleepHours: number; spend: number; gratitude: number; followUpsDue: number
}
export type WeeklyReview = {
  id: string; weekStart: string; doneText: string; slippedText: string; focusText: string; createdAt: string
}
export const apiWeeklyReview = (a: { email?: string; token?: string }) =>
  featureGet<{ weekStart: string; snapshot: WeeklySnapshot; current: WeeklyReview | null; reviews: WeeklyReview[] }>(
    '/api/weekly-review',
    authQuery(a),
  )
export const apiSaveWeeklyReview = (a: {
  email?: string; token?: string; weekStart: string; doneText: string; slippedText: string; focusText: string
}) => featurePost<{ ok: boolean }>('/api/weekly-review', { ...authParams(a), weekStart: a.weekStart, doneText: a.doneText, slippedText: a.slippedText, focusText: a.focusText })

/* ---- Home (today) ---- */
export type HomeSnapshot = {
  weekStart: string
  /**
   * The calendar and inbox were still loading when this answered, so `upcoming`
   * and `mailGroups` may be empty for reasons other than an empty week. One
   * refetch a moment later gets them.
   */
  worldPending?: boolean
  home: {
    weekday: string
    dateLabel: string
    hour: number
    upcoming: Array<{ time: string; title: string }>
    mail: Array<{ from: string; subject: string }>
    /**
     * The same mail, grouped by kinds the judge named for this user. Optional
     * because an API deployed before the groups existed only sends `mail`.
     */
    mailGroups?: Array<{
      kind: string
      label: string
      count: number
      items: Array<{ id: string; from: string; subject: string; snippet?: string }>
    }>
    /**
     * `id` is what lets home mark someone touched instead of only naming them;
     * optional because an API deployed before it existed sends the rest, and the
     * queue degrades that row to a link rather than an unpressable button.
     */
    peopleDue: Array<{ name: string; days: number; phone?: string; id?: string; context?: string }>
    /** The single open promise closest to its deadline, so home can close one. */
    dueLoop?: { id: string; title: string; dueAt?: string | null } | null
    lastNight: { logged: boolean; hours: number; bedtime?: string; wake?: string }
    workout: { name: string; rest?: boolean; done: boolean }
  }
  window: {
    meals: number; calories: number; moodLogs: number; avgEnergy: number
    habitChecks: number; habits: string[]; sleepNights: number; avgSleepHours: number
    spend: number; weeklyBudget: number; workouts: number
    learningQueued: number; learningDone: number; gratitude: number
    decisionsOpen: number; decisionsResolved: number
    proteinToday?: number; proteinGoal?: number; caloriesToday?: number; calorieGoal?: number
    lastNightHours?: number; shortNights?: number; workoutsToday?: number
  }
  moodTrend: Array<{ emoji: string; energy: number; date: string }>
  sleepTrend: Array<{ date: string; hours: number; quality: number }>
  spendByCategory: Array<{ category: string; amount: number }>
  prs: Array<{ exercise: string; weight: number }>
  nextLearning: string | null
  currentReview: WeeklyReview | null
  reviews: WeeklyReview[]
}
/**
 * This screen used to be '/api/mirror'. The server answers both paths, but a
 * client built after the rename can reach an API instance deployed before it,
 * so fall back rather than show "Could not load home." Drop the fallback once
 * the API has been out for a release.
 */
export const apiHome = async (a: { email?: string; token?: string }) => {
  try {
    // The endpoint revalidates at 60s; without a bust query the browser serves
    // its cached 200 to an immediate reopen, so food logged off-home shows its
    // old protein until the window expires. Each open should ask the server.
    const qs = authQuery(a)
    qs.set('_', String(Date.now()))
    return await featureGet<HomeSnapshot>('/api/home', qs)
  } catch {
    const qs = authQuery(a)
    qs.set('_', String(Date.now()))
    return await featureGet<HomeSnapshot>('/api/mirror', qs)
  }
}

/* ---- Networking CRM ---- */
export type NetworkPerson = {
  id: string
  name: string
  whereMet: string
  context: string
  lastTouch: string | null
  cadenceDays: number
  createdAt: string
  phone?: string
  contactEmail?: string
  company?: string
}
export type NetworkToday = { time: string; title: string; who: string; place: string; kind: string }
export type NetworkStay = { title: string; place: string }
export const apiListNetwork = (a: { email?: string; token?: string; persona?: string }) =>
  featureGet<{ people: NetworkPerson[]; today?: NetworkToday[]; stay?: NetworkStay | null; calendarConnected?: boolean }>('/api/network', authQuery(a))
export const apiAddNetwork = (a: {
  email?: string; token?: string; name: string; whereMet?: string; context?: string; cadenceDays?: number
  phone?: string; contactEmail?: string; company?: string
}) => featurePost<{ ok: boolean; id: string }>('/api/network', {
  ...authParams(a),
  name: a.name,
  whereMet: a.whereMet,
  context: a.context,
  cadenceDays: a.cadenceDays,
  phone: a.phone,
  contactEmail: a.contactEmail,
  company: a.company,
})
export const apiTouchNetwork = (a: { email?: string; token?: string; id: string; context?: string; _delete?: boolean }) =>
  featurePost<{ ok: boolean }>(`/api/network/${a.id}`, { ...authParams(a), context: a.context, _delete: a._delete })
export const apiSaveNetwork = (a: {
  email?: string; token?: string; id: string
  name: string; phone?: string; contactEmail?: string; company?: string
  whereMet?: string; context?: string; cadenceDays?: number
}) => featurePost<{ ok: boolean }>(`/api/network/${a.id}`, {
  ...authParams(a),
  save: true,
  name: a.name,
  phone: a.phone,
  contactEmail: a.contactEmail,
  company: a.company,
  whereMet: a.whereMet,
  context: a.context,
  cadenceDays: a.cadenceDays,
})

/* ---- Sleep ---- */
export type SleepNight = {
  id: string; sleepDate: string; bedtime: string; wake: string; quality: number; note: string | null; source?: string | null; createdAt: string
}
export const apiListSleep = (a: { email?: string; token?: string }) =>
  featureGet<{ nights: SleepNight[]; sleepBedtime?: string; sleepWake?: string }>('/api/sleep', authQuery(a))
export const apiLogSleep = (a: {
  email?: string; token?: string; sleepDate?: string; bedtime: string; wake: string; quality: number; note?: string
}) => featurePost<{ ok: boolean }>('/api/sleep', { ...authParams(a), sleepDate: a.sleepDate, bedtime: a.bedtime, wake: a.wake, quality: a.quality, note: a.note })
export const apiDeleteSleep = (a: { email?: string; token?: string; id: string }) =>
  featurePost<{ ok: boolean }>(`/api/sleep/${a.id}`, { ...authParams(a), _delete: true })
export const apiIngestSleep = (a: {
  token?: string; email?: string; sleepDate?: string; bedtime: string; wake: string; source?: string
}) => featurePost<{ ok: boolean; sleepDate?: string; bedtime?: string; wake?: string }>(
  '/api/sleep/ingest',
  { ...authParams(a), sleepDate: a.sleepDate, bedtime: a.bedtime, wake: a.wake, source: a.source || 'apple_health' },
)

/* ---- Pipeline ---- */
export type PipelineItem = {
  id: string; title: string; company: string; stage: string; notes: string; createdAt: string; updatedAt: string
}
export const apiListPipeline = (a: { email?: string; token?: string }) =>
  featureGet<{ items: PipelineItem[] }>('/api/pipeline', authQuery(a))
export const apiAddPipeline = (a: {
  email?: string; token?: string; title: string; company?: string; stage?: string; notes?: string
}) => featurePost<{ ok: boolean; id: string }>('/api/pipeline', { ...authParams(a), title: a.title, company: a.company, stage: a.stage, notes: a.notes })
export const apiPatchPipeline = (a: { email?: string; token?: string; id: string; stage?: string; _delete?: boolean }) =>
  featurePost<{ ok: boolean }>(`/api/pipeline/${a.id}`, { ...authParams(a), stage: a.stage, _delete: a._delete })

/* ---- Gratitude ---- */
export type GratitudeEntry = { id: string; text: string; createdAt: string }
export const apiListGratitude = (a: { email?: string; token?: string }) =>
  featureGet<{ entries: GratitudeEntry[]; weekCount: number }>('/api/gratitude', authQuery(a))
export const apiAddGratitude = (a: { email?: string; token?: string; text: string }) =>
  featurePost<{ ok: boolean; id: string }>('/api/gratitude', { ...authParams(a), text: a.text })
export const apiDeleteGratitude = (a: { email?: string; token?: string; id: string }) =>
  featurePost<{ ok: boolean }>(`/api/gratitude/${a.id}`, { ...authParams(a), _delete: true })

/* ---- Spending ---- */
export type SpendLog = { id: string; amount: number; category: string; description: string; spentAt: string }
export const apiListSpending = (a: { email?: string; token?: string }) =>
  featureGet<{
    logs: SpendLog[]; byCategory: Array<{ category: string; total: number }>
    weekTotal: number; weeklyBudget: number; weekStart: string
  }>('/api/spending', authQuery(a))
export const apiLogSpend = (a: {
  email?: string; token?: string; amount: number; category: string; description?: string
}) => featurePost<{ ok: boolean; id: string }>('/api/spending', { ...authParams(a), amount: a.amount, category: a.category, description: a.description })
export const apiSetSpendBudget = async (a: { email?: string; token?: string; weeklyBudget: number }) => {
  const res = await fetch(`${API}/api/spending/budget`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...authParams(a), weeklyBudget: a.weeklyBudget }),
  })
  const data = await parseJson<{ ok?: boolean; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}
export const apiDeleteSpend = (a: { email?: string; token?: string; id: string }) =>
  featurePost<{ ok: boolean }>(`/api/spending/${a.id}`, { ...authParams(a), _delete: true })

/* ---- Work cards: Next, send, slots, Linear ---- */
export type WorkDraft = {
  id: string
  kind: string
  toAddr: string
  subject: string
  body: string
  status: string
  createdAt: string
  threadId?: string
  inReplyTo?: string
  startAt?: string
  endAt?: string
}
export type SlotOption = { start: string; end: string; label: string; title?: string }
export type LinearIssue = {
  id: string
  identifier: string
  title: string
  state?: string
  team?: string
  url?: string
}
export type NextItem = {
  id: string
  kicker: string
  title: string
  hint?: string
  hot?: boolean
  action: 'send' | 'hold' | 'loop' | 'person' | 'linear' | 'rsvp' | 'pipeline' | 'open'
  doLabel?: string
  draftId?: string
  loopId?: string
  personId?: string
  issueId?: string
  eventId?: string
  pipelineId?: string
  stage?: string
  start?: string
  end?: string
  sms?: string
  href?: string
  openKind?: string
  messageId?: string
}

async function fallbackNextStack(a: { email?: string; token?: string; persona?: string }) {
  const items: NextItem[] = []
  const [loopsRes, peopleRes] = await Promise.all([
    apiListLoops(a).catch(() => ({ loops: [] as OpenLoop[] })),
    apiListNetwork(a).catch(() => ({ people: [] as NetworkPerson[] })),
  ])
  const now = Date.now()
  const open = (loopsRes.loops || []).filter((l) => l.status === 'open')
  const due = open.find((l) => l.dueAt && new Date(l.dueAt).getTime() <= now + 12 * 60 * 60 * 1000) || open[0]
  if (due) {
    items.push({
      id: `loop-${due.id}`,
      kicker: 'Promise',
      title: due.title,
      hint: due.dueAt ? 'Due' : 'Open',
      hot: true,
      action: 'loop',
      doLabel: 'Close',
      loopId: due.id,
    })
  }
  const overdue = (peopleRes.people || []).find((p) => {
    const last = p.lastTouch ? new Date(p.lastTouch).getTime() : 0
    return (Date.now() - last) / 86400000 >= (p.cadenceDays || 14)
  })
  if (overdue) {
    items.push({
      id: `person-${overdue.id}`,
      kicker: 'Ping',
      title: overdue.name,
      hint: overdue.context || 'Overdue',
      hot: true,
      action: 'person',
      doLabel: 'Talked',
      personId: overdue.id,
      sms: `sms:&body=${encodeURIComponent(`Hey ${overdue.name.split(' ')[0] || overdue.name} — checking in.`)}`,
    })
  }
  let connected: string[] = []
  if (a.email) {
    const me = await apiMe(a.email).catch(() => null)
    connected = me?.connected || []
  }
  const want = a.persona === 'coworker' ? ['gmail', 'calendar', 'linear'] : ['gmail', 'calendar']
  return { items, connected, missing: want.filter((id) => !connected.includes(id)) }
}

export const apiNextStack = async (a: { email?: string; token?: string; persona?: string }) => {
  try {
    return await featureGet<{ items: NextItem[]; connected: string[]; missing: string[] }>('/api/work/next', authQuery(a))
  } catch {
    return fallbackNextStack(a)
  }
}
export const apiListWorkDrafts = (a: { email?: string; token?: string; persona?: string; kind?: string }) => {
  const qs = authQuery(a)
  if (a.kind) qs.set('kind', a.kind)
  return featureGet<{
    drafts: WorkDraft[]
    needConnect?: boolean
    investorDraft?: { subject: string; body: string }
  }>('/api/work/drafts', qs)
}
export const apiSaveWorkDraft = (a: {
  email?: string; token?: string; persona?: string
  kind?: string; toAddr: string; subject: string; body: string
}) => featurePost<{ ok: boolean; id: string }>('/api/work/drafts', {
  ...authParams(a), persona: a.persona, kind: a.kind, toAddr: a.toAddr, subject: a.subject, body: a.body,
})
export const apiSendDraft = (a: {
  email?: string; token?: string; persona?: string
  id?: string; toAddr?: string; subject?: string; body?: string
}) => featurePost<{ ok: boolean; error?: string }>('/api/work/send', {
  ...authParams(a), persona: a.persona, id: a.id, toAddr: a.toAddr, subject: a.subject, body: a.body,
})
export const apiListSlots = (a: { email?: string; token?: string; persona?: string }) =>
  featureGet<{ slots: SlotOption[]; needConnect?: boolean }>('/api/work/slots', authQuery(a))
export const apiHoldSlot = (a: {
  email?: string; token?: string; persona?: string; title: string; start: string; end: string; id?: string
}) => featurePost<{ ok: boolean; error?: string; eventId?: string }>('/api/work/hold', {
  ...authParams(a), persona: a.persona, title: a.title, start: a.start, end: a.end, id: a.id,
})
export const apiListLinear = (a: { email?: string; token?: string; persona?: string }) =>
  featureGet<{ issues: LinearIssue[]; needConnect?: boolean }>('/api/work/linear', authQuery(a))
export const apiLinearAction = (a: {
  email?: string; token?: string; persona?: string; id: string; action: 'done' | 'later' | 'cancel'
}) => featurePost<{ ok: boolean; error?: string }>('/api/work/linear', {
  ...authParams(a), persona: a.persona, id: a.id, action: a.action,
})
export const apiRsvpEvent = (a: {
  email?: string; token?: string; eventId: string; response: 'accepted' | 'declined'
}) => featurePost<{ ok: boolean; error?: string }>('/api/work/rsvp', {
  ...authParams(a), eventId: a.eventId, response: a.response,
})
export const apiDayEvents = (a: { email?: string; token?: string; persona?: string }) =>
  featureGet<{
    events: Array<{ id: string; title: string; start: string; label: string }>
  }>('/api/work/day', authQuery(a))

/* ---- Mail reader ---- */
export type MailMessage = {
  ok: boolean
  messageId?: string
  subject?: string
  from?: string
  date?: string
  bodyText?: string
  bodyHtml?: string
  snippet?: string
  error?: string
}

export const apiGetMailMessage = (a: { email?: string; token?: string; messageId: string }) => {
  const qs = new URLSearchParams()
  if (a.email) qs.set('email', a.email)
  else if (a.token) qs.set('t', a.token)
  return fetch(`/api/mail/${encodeURIComponent(a.messageId)}?${qs}`).then(async (res) => {
    const text = await res.text()
    try {
      return JSON.parse(text) as MailMessage
    } catch {
      return { ok: false, error: 'Request failed' } as MailMessage
    }
  })
}

/* ---- Brief v2: triage, drafts from mail, reminders, prep ---- */
export type MailTriageAction = 'done' | 'skip' | 'drafted' | 'opened'
export const apiTriageMail = (a: {
  email?: string; token?: string; persona?: string
  id: string; action: MailTriageAction; sender?: string; kind?: string
}) =>
  featurePost<{ ok: boolean }>('/api/mail/triage', {
    ...authParams(a), id: a.id, action: a.action, sender: a.sender || '', kind: a.kind || '',
  })

/** A generated reply ready to review: the reader prefills a compose panel from it. */
export type ReplyDraft = { id: string; toAddr: string; subject: string; body: string }

export const apiDraftMailReply = (
  a: { email?: string; token?: string; persona?: string; id: string },
) =>
  featurePost<{ ok: boolean; id: string; toAddr: string; subject: string; body?: string; error?: string }>(
    '/api/mail/draft',
    { ...authParams(a), persona: a.persona, id: a.id },
  )

/** Ask Alpha to rework a stored draft's body. */
export const apiRewriteDraft = (
  a: { email?: string; token?: string; id: string; instruction: string },
) =>
  featurePost<{ ok: boolean; body: string; error?: string }>('/api/mail/draft/rewrite', {
    ...authParams(a), id: a.id, instruction: a.instruction,
  })

export const apiReminderAction = (a: {
  email?: string; token?: string; id: string; action: 'done' | 'snooze'; hours?: number
}) =>
  featurePost<{ ok: boolean }>('/api/reminders/action', {
    ...authParams(a), id: a.id, action: a.action, hours: a.hours,
  })

export type PrepBundle = {
  ok: boolean
  text: string
  draft?: { kind: 'mail'; to: string; subject: string; body: string } | { kind: 'reply'; messageId: string; body: string }
  error?: string
}
export const apiPrepFor = (a: { email?: string; token?: string; name: string }) =>
  featurePost<PrepBundle>('/api/prep', { ...authParams(a), name: a.name })

/* ---- Mini app prefs (workout place, move count, usual sleep times) ---- */
export type MiniPrefs = {
  workoutPlace: 'home' | 'gym'
  workoutMoveCount: 4 | 5 | 6
  sleepBedtime: string
  sleepWake: string
}
export const apiGetMiniPrefs = (a: { email?: string; token?: string }) =>
  featureGet<MiniPrefs>('/api/mini-prefs', authQuery(a))
export const apiPutMiniPrefs = async (
  a: { email?: string; token?: string } & Partial<MiniPrefs>,
) => {
  const res = await fetch(`${API}/api/mini-prefs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...authParams(a),
      workoutPlace: a.workoutPlace,
      workoutMoveCount: a.workoutMoveCount,
      sleepBedtime: a.sleepBedtime,
      sleepWake: a.sleepWake,
    }),
  })
  const data = await parseJson<MiniPrefs & { ok?: boolean; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not save settings')
  return data
}

