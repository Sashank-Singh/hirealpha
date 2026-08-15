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

export type Meeting = {
  id: string
  title: string
  startsAt: string | null
  phase: string
  briefing: string | null
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
