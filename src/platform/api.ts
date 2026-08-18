import type { AgentId } from '../agents/types'
import type { ConnectorId } from './connectors'

const API = ''

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(text.slice(0, 180) || `Request failed (${res.status})`)
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
  return { email: input.email, token: input.token }
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

export const apiListLoops = (a: { email?: string; token?: string }) => {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return featureGet<{ loops: OpenLoop[] }>('/api/loops', qs)
}
export const apiAddLoop = (a: { email?: string; token?: string; persona?: string; title: string; context?: string; dueAt?: string }) =>
  featurePost<{ ok: boolean; id: string }>('/api/loops', { ...authParams(a), persona: a.persona, title: a.title, context: a.context, dueAt: a.dueAt })
export const apiPatchLoop = (a: { email?: string; token?: string; id: string; status: string }) =>
  featurePatch<{ ok: boolean }>(`/api/loops/${a.id}`, { ...authParams(a), status: a.status })

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
export const apiListDecisions = (a: { email?: string; token?: string }) => {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return featureGet<{ decisions: Decision[] }>('/api/decisions', qs)
}
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
export const apiListRelationships = (a: { email?: string; token?: string }) => {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return featureGet<{ relationships: Relationship[] }>('/api/relationships', qs)
}
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
export const apiListDrops = (a: { email?: string; token?: string }) => {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return featureGet<{ drops: Drop[] }>('/api/dropzone', qs)
}
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
export const apiListMeetings = (a: { email?: string; token?: string }) => {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return featureGet<{ meetings: Meeting[] }>('/api/meetings', qs)
}
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
export const apiNutritionToday = (a: { email?: string; token?: string }) => {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return featureGet<{ goals: NutritionGoals; logs: NutritionLog[]; totals: { calories: number; protein: number; carbs: number; fat: number } }>('/api/nutrition', qs)
}
export const apiLogNutrition = (a: {
  email?: string; token?: string; description: string
  calories?: number; protein?: number; carbs?: number; fat?: number; imageUrl?: string
}) => featurePost<{ ok: boolean; id: string }>('/api/nutrition', { ...authParams(a), description: a.description, calories: a.calories, protein: a.protein, carbs: a.carbs, fat: a.fat, imageUrl: a.imageUrl })
export const apiSetNutritionGoals = (a: { email?: string; token?: string } & Partial<NutritionGoals>) => {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return fetch(`${API}/api/nutrition/goals`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(a),
  }).then((res) => parseJson<{ ok?: boolean; error?: string }>(res))
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
export const apiListHabits = (a: { email?: string; token?: string }) => {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return featureGet<{
    habits: (Habit & { streak: number; recentDays: string[] })[]
    weekDays?: string[]
    weekStart?: string
  }>('/api/habits', qs)
}
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
export const apiListMoods = (a: { email?: string; token?: string }) => {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return featureGet<{ entries: MoodEntry[]; streak: number }>('/api/moods', qs)
}
export const apiLogMood = (a: { email?: string; token?: string; emoji: string; energy: number; note?: string }) =>
  featurePost<{ ok: boolean; id: string }>('/api/moods', { ...authParams(a), emoji: a.emoji, energy: a.energy, note: a.note })

function authQuery(a: { email?: string; token?: string }) {
  const qs = new URLSearchParams()
  if (a.token) qs.set('t', a.token)
  else if (a.email) qs.set('email', a.email)
  return qs
}

/* ---- Workouts ---- */
export type WorkoutLog = {
  id: string; exercise: string; sets: number; reps: number; weight: number; notes: string | null; loggedAt: string
}
export type WorkoutPr = { exercise: string; weight: number; reps: number; loggedAt: string }
export const apiListWorkouts = (a: { email?: string; token?: string }) =>
  featureGet<{ logs: WorkoutLog[]; prs: WorkoutPr[] }>('/api/workouts', authQuery(a))
export const apiLogWorkout = (a: {
  email?: string; token?: string; exercise: string; sets: number; reps: number; weight?: number; notes?: string
}) => featurePost<{ ok: boolean; id: string }>('/api/workouts', { ...authParams(a), exercise: a.exercise, sets: a.sets, reps: a.reps, weight: a.weight, notes: a.notes })
export const apiDeleteWorkout = (a: { email?: string; token?: string; id: string }) =>
  featurePost<{ ok: boolean }>(`/api/workouts/${a.id}`, { ...authParams(a), _delete: true })

/* ---- Learning queue ---- */
export type LearningItem = {
  id: string; title: string; url: string | null; kind: string; minutes: number; status: string; createdAt: string
}
export const apiListLearning = (a: { email?: string; token?: string }) =>
  featureGet<{ items: LearningItem[] }>('/api/learning', authQuery(a))
export const apiAddLearning = (a: {
  email?: string; token?: string; title: string; url?: string; kind?: string; minutes?: number
}) => featurePost<{ ok: boolean; id: string }>('/api/learning', { ...authParams(a), title: a.title, url: a.url, kind: a.kind, minutes: a.minutes })
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

/* ---- Mirror (life reflection dashboard) ---- */
export type MirrorSnapshot = {
  weekStart: string
  window: {
    meals: number; calories: number; moodLogs: number; avgEnergy: number
    habitChecks: number; habits: string[]; sleepNights: number; avgSleepHours: number
    spend: number; weeklyBudget: number; workouts: number
    learningQueued: number; learningDone: number; gratitude: number
    decisionsOpen: number; decisionsResolved: number
  }
  moodTrend: Array<{ emoji: string; energy: number; date: string }>
  sleepTrend: Array<{ date: string; hours: number; quality: number }>
  spendByCategory: Array<{ category: string; amount: number }>
  prs: Array<{ exercise: string; weight: number }>
  nextLearning: string | null
  currentReview: WeeklyReview | null
  reviews: WeeklyReview[]
}
export const apiMirror = (a: { email?: string; token?: string }) =>
  featureGet<MirrorSnapshot>('/api/mirror', authQuery(a))

/* ---- Networking CRM ---- */
export type NetworkPerson = {
  id: string; name: string; whereMet: string; context: string; lastTouch: string | null; cadenceDays: number; createdAt: string
}
export const apiListNetwork = (a: { email?: string; token?: string }) =>
  featureGet<{ people: NetworkPerson[] }>('/api/network', authQuery(a))
export const apiAddNetwork = (a: {
  email?: string; token?: string; name: string; whereMet?: string; context?: string; cadenceDays?: number
}) => featurePost<{ ok: boolean; id: string }>('/api/network', { ...authParams(a), name: a.name, whereMet: a.whereMet, context: a.context, cadenceDays: a.cadenceDays })
export const apiTouchNetwork = (a: { email?: string; token?: string; id: string; context?: string; _delete?: boolean }) =>
  featurePost<{ ok: boolean }>(`/api/network/${a.id}`, { ...authParams(a), context: a.context, _delete: a._delete })

/* ---- Sleep ---- */
export type SleepNight = {
  id: string; sleepDate: string; bedtime: string; wake: string; quality: number; note: string | null; createdAt: string
}
export const apiListSleep = (a: { email?: string; token?: string }) =>
  featureGet<{ nights: SleepNight[] }>('/api/sleep', authQuery(a))
export const apiLogSleep = (a: {
  email?: string; token?: string; sleepDate?: string; bedtime: string; wake: string; quality: number; note?: string
}) => featurePost<{ ok: boolean }>('/api/sleep', { ...authParams(a), sleepDate: a.sleepDate, bedtime: a.bedtime, wake: a.wake, quality: a.quality, note: a.note })
export const apiDeleteSleep = (a: { email?: string; token?: string; id: string }) =>
  featurePost<{ ok: boolean }>(`/api/sleep/${a.id}`, { ...authParams(a), _delete: true })

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

