/**
 * AGI-capability audit harness.
 *
 * Drives the REAL turn engine (runHireTurn) with the REAL model (GMI from .env),
 * while intercepting every non-LLM network call: the HireAlpha internal API,
 * web search, maps, pages — all answered from a per-scenario scripted World.
 * Nothing here touches prod: no iMessage, no Postgres, no Composio, no real
 * sends. Thread memory is files under a per-scenario temp dir.
 *
 * Usage: bun testbed/audit/harness.ts <scenarioId|all> [...more]
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { runHireTurn } from '../../spectrum/shared/runHireTurn'
import { parseCompletionEvidence } from '../../spectrum/shared/completion'
import { setCompletionObserver } from '../../spectrum/shared/conversationalFriend'
import { claimViolationCount } from '../../spectrum/shared/claimEvidence'

/* Route the engine at this process BEFORE any scenario runs. Without this the
 * engine falls into its no-API fallback: reads return empty and browser
 * proposals spawn REAL local Playwright sessions against real sites. */
process.env.HIREALPHA_API_URL = 'http://audit-hireapi.internal'
process.env.HIREALPHA_INTERNAL_KEY = process.env.HIREALPHA_INTERNAL_KEY || 'audit-internal-key'

type Json = Record<string, any>

export interface Call { t: number; method: string; path: string; body: Json }

export interface World {
  id: string
  profile: {
    name: string; phone: string; timezone: string; email: string
    hired: boolean; connected: string[]
    memories: Array<{ key: string; value: string; durable?: boolean }>
    homeAddress?: string; workAddress?: string; vaultOrigins?: string[]
  }
  mail: Array<{ id: string; from: string; to?: string; subject: string; snippet: string; threadId?: string; date?: string }>
  events: Array<{ title: string; when: string }>
  freeSlots: Array<{ start: string; end: string; label: string }>
  webResults: Array<{ match: RegExp; results: string[] }>
  mapsResults: string[]
  drive: Array<{ id: string; name: string; mimeType: string; size: number; webViewLink?: string }>
  contacts: Array<{ name: string; phone?: string; email?: string; last_touch?: string }>
  spending: { logs: Array<{ amount: number; category: string; description: string; spentAt: string }>; weekly: number; budget: number }
  slackChannels: string[]
  /** failure / behavior injection */
  fx: {
    propose?: 'ok' | 'no_id' | 'throw' | 'fail500'
    spendDecide?: 'succeed' | 'charged_false' | 'throw' | 'fail500'
    reminder?: 'ok' | 'fail500'
    scheduledText?: 'ok' | 'fail500'
    liveTools?: 'ok' | 'empty' | 'fail500'
    calendarSlots?: 'ok' | 'fail500'
    /** when set, overrides default propose response entirely */
    proposeResponse?: Json
  }
  calls: Call[]
  created: {
    drafts: Json[]; reminders: Json[]; scheduledTexts: Json[]; commitments: Json[]
    memoryWrites: Json[]; memoryDeletes: Json[]; spendDecisions: Json[]
    browserTasks: Json[]; followups: Json[]; calendarMutations: Json[]
    fileSends: Json[]; workWrites: Json[]; taskChoices: Json[]; watches: Json[]; anchors?: Json[]; plans?: Json[]; cancels?: Json[]; spendApprovals?: Json[]
    todos: Json[]; loops: Json[]; otherWrites: Json[]
  }
}

export interface TurnDef {
  text: string
  note?: string
  /** mutate the world before this turn (reality changes mid-task) */
  w?: (world: World) => void
  /** simulated days elapsed after previous turn (ages thread timestamps) */
  ageDays?: number
}

export interface Scenario {
  id: string
  cat: string
  title: string
  agent?: 'friend' | 'coworker' | 'cofounder'
  world: () => Omit<World, 'id' | 'calls' | 'created' | 'fx'>
  turns: TurnDef[]
  /** Assessment metrics: which evidence sources a correct answer needs. */
  requiredSources?: string[]
}

const OUT = join(import.meta.dir, 'out')

let CURRENT: World | null = null
let LLM_CALLS = 0
const realFetch = globalThis.fetch

function jres(obj: Json, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

function rec(world: World, method: string, url: string, body: Json): Call {
  const path = url.replace(/^https?:\/\/[^/]+/, '')
  const c: Call = { t: Date.now(), method, path: path.slice(0, 200), body }
  world.calls.push(c)
  return c
}

/* ---------- interception ---------- */

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase()
  let body: Json = {}
  if (init?.body && typeof init.body === 'string') { try { body = JSON.parse(init.body) } catch { body = { raw: init.body.slice(0, 300) } } }

  // The only real network traffic: the model.
  if (url.includes('/chat/completions')) {
    LLM_CALLS++
    return realFetch(input, init)
  }

  const w = CURRENT
  if (!w) return jres({ ok: false, error: 'no world' }, 500)

  // LangSearch: the engine's local web path. Serve world-scripted results in
  // LangSearch's own response shape; without a scripted hit say "nothing usable".
  if (/api\.langsearch\.com/i.test(url)) {
    let query = ''
    try { query = String(JSON.parse(String(init?.body || '{}')).query || '') } catch { /* keep empty */ }
    const w0 = CURRENT
    const hit = w0?.webResults.find((r) => r.match.test(query))
    const items = hit
      ? hit.results.map((s, i) => ({ name: s.slice(0, 80), url: `https://source${i}.auditnews.example/page`, snippet: s, summary: s }))
      : [{ name: query.slice(0, 60), url: 'https://audit-none.example/search', snippet: `Search ran for "${query.slice(0, 100)}". No directly relevant page found in results.`, summary: `Search ran for "${query.slice(0, 100)}". No directly relevant page found in results.` }]
    return jres({ code: 200, data: { webPages: { value: items } } })
  }
  // Other search engines + page fetches: deterministic 500 → engine falls back
  // to the scripted /api/internal/live/tools endpoint. Instant and offline.
  if (/brave\.com|bing\.com|duckduckgo|yahoo\.com|googleapis\.com\/customsearch|serpapi|nominatim|openstreetmap/i.test(url)) {
    return jres({ error: 'offline in audit' }, 500)
  }
  // Any page fetch for browser-less reads
  if (!url.includes('/api/internal/')) {
    rec(w, method, url, body)
    return jres({ offline: true }, 404)
  }

  rec(w, method, url, body)
  return handleInternal(w, method, url, body)
}) as typeof fetch

function bucket<T>(w: World, key: keyof World['created']): T[] {
  return w.created[key] as unknown as T[]
}

function handleInternal(w: World, method: string, url: string, body: Json): Response {
  const u = new URL(url)
  const p = u.pathname

  /* plans */
  if (p === '/api/internal/plans') {
    if (method === 'GET') {
      const plan = (w.created.plans || []).find((pl: Json) => pl.status === 'active') || (w.created.plans || [])[0] || null
      return jres({ ok: true, plan })
    }
    if (method === 'POST') {
      const existing = (w.created.plans || []).find((pl: Json) => pl.goal === body.goal)
      const plan = {
        id: existing?.id || `plan_${(w.created.plans || []).length + 1}`,
        goal: body.goal, persona: body.persona || 'friend', status: 'active',
        blocker: null, nextAction: body.nextAction ?? null,
        steps: body.steps || [], operationIds: body.operationIds || {},
        updatedAt: new Date().toISOString(),
      }
      if (existing) Object.assign(existing, plan)
      else (w.created.plans ||= []).push(plan)
      return jres({ ok: true, plan })
    }
    if (method === 'PATCH') {
      const plan = (w.created.plans || []).find((pl: Json) => pl.id === body.id)
      if (!plan) return jres({ ok: false, error: 'Plan not found' }, 404)
      for (const k of ['steps', 'blocker', 'nextAction', 'status', 'operationIds'] as const) {
        if (body[k] !== undefined) plan[k] = body[k]
      }
      return jres({ ok: true, plan })
    }
  }

  /* spend state read */
  if (p === '/api/internal/spend/state') {
    const req = w.created.spendApprovals?.[0]
    return jres({ ok: true, state: req?.state || 'pending_approval', amountCents: (req?.amount || 42) * 100, purpose: req?.item || 'item' })
  }

  /* cancel work */
  if (p === '/api/internal/work/cancel') {
    const kinds: string[] = body.kinds || ['browser', 'watch', 'followup', 'scheduled_text']
    const results = kinds.map((kind) => {
      if (kind === 'browser' && w.created.browserTasks.length) {
        return { target: 'browser', id: 'job_1', state: 'cancellation_requested', priorStatus: 'running' }
      }
      return { target: kind, id: null, state: 'not_cancellable' }
    })
    bucket<Json>(w, 'cancels').push({ kinds, results })
    return jres({ ok: true, results })
  }

  /* send an existing draft */
  if (p === '/api/internal/mail/send-draft') {
    bucket<Json>(w, 'drafts').push({ kind: 'send_draft', ...body })
    return jres({ ok: true, state: 'sent', providerId: 'smtp_audit_1', toAddr: 'dana@bigco.com', version: 1 })
  }

  /* verified-completion ledger fixture */
  if (p === '/api/internal/completions') {
    ;(w as unknown as { completions?: Json[] }).completions ||= []
    const store = (w as unknown as { completions: Json[] }).completions
    if (method === 'POST' && !body.id && !body.action) {
      const targetKey = String(body.target || '').toLowerCase()
      const dup = store.find((c) => c.kind === body.kind && c.targetKey === targetKey && c.state !== 'completed' && c.state !== 'failed' && c.state !== 'cancelled')
      if (dup) return jres({ ok: true, completion: dup, duplicate: true })
      const row = { id: `cmpl_${store.length + 1}`, kind: body.kind, target: body.target, targetKey, state: 'pending', receipt: null, evidence: null, blocker: null, result_summary: null }
      store.push(row)
      return jres({ ok: true, completion: row })
    }
    if (method === 'POST' && body.id && body.action === 'verify') {
      const row = store.find((c) => c.id === body.id)
      const observed = String(body.observed || '')
      const kind = (row?.kind || 'subscription_cancel') as Parameters<typeof parseCompletionEvidence>[0]
      const evidence = parseCompletionEvidence(kind, observed, String(body.target || row?.target || ''))
      if (!evidence || evidence.type === 'none' || evidence.type === 'retention_offer') {
        if (row) row.state = evidence?.type === 'retention_offer' ? 'needs_authorization' : 'outcome_unknown'
        if (row && evidence) row.blocker = { type: evidence.type === 'retention_offer' ? 'retention_offer' : 'observed', message: evidence.summary }
        return jres({ ok: true, state: row?.state || 'outcome_unknown', verified: false, ...(evidence?.type === 'retention_offer' ? { retentionOffer: evidence.retentionOffer } : {}), ...(evidence?.type === 'none' ? { blocker: evidence.summary } : {}) })
      }
      if (row) {
        row.state = 'completed'
        row.receipt = { operation: kind, status: 'completed', provider: evidence.provider || String(body.target || 'unknown'), verified_at: new Date().toISOString(), evidence, result_summary: evidence.summary }
      }
      return jres({ ok: true, state: 'completed', verified: true, receipt: row?.receipt })
    }
    if (method === 'GET') {
      return jres({ ok: true, completions: (w as unknown as { completions: Json[] }).completions })
    }
  }

  /* durable turn anchors (the "send it" memory) */
  if (p === '/api/internal/anchors') {
    w.created.otherWrites.push({ path: p + ':' + method, ...body })
    if (method === 'GET') return jres({ anchors: (w.created.anchors || []).filter((a: Json) => new Date(a.expiresAt).getTime() > Date.now()) })
    if (method === 'DELETE') {
      w.created.anchors = (w.created.anchors || []).filter((a: Json) => a.kind !== body.kind)
      return jres({ ok: true })
    }
    const expiresAt = new Date(Date.now() + ((body.ttlHours || 24) as number) * 3600_000).toISOString()
    w.created.anchors = [...(w.created.anchors || []), { kind: body.kind, ref: body.ref, createdAt: new Date().toISOString(), expiresAt }]
    return jres({ ok: true })
  }

  /* profile + tools */
  if (p === '/api/internal/live') {
    const m = w.profile
    return jres({
      found: true, hired: m.hired, userId: 'audit-user', email: m.email, name: m.name,
      phone: m.phone, timezone: m.timezone, context: { timezone: m.timezone },
      connected: m.connected, vaultOrigins: m.vaultOrigins || [], memories: m.memories,
      deletedKeys: [], homeAddress: m.homeAddress ?? null, workAddress: m.workAddress ?? null, unavailable: false,
    })
  }
  if (p === '/api/internal/live/tools') {
    const fx = w.fx.liveTools || 'ok'
    if (fx === 'fail500') return jres({ error: 'down' }, 500)
    if (fx === 'empty') return jres({ results: [] })
    const want = String(body.want || '')
    const msg = String(body.message || '')
    let results: string[] = []
    if (want === 'gmail') {
      results = w.mail.map((m) => `id=${m.id} from=${m.from} subject="${m.subject}". ${m.snippet}`)
    } else if (want === 'calendar') {
      results = w.events.map((e) => `${e.title} — ${e.when}`)
    } else if (want === 'drive') {
      results = w.drive.map((d) => `- ${d.name} (${d.mimeType}) ${d.webViewLink || ''}`)
    } else if (want === 'maps') {
      results = w.mapsResults
    } else if (want === 'web') {
      const hit = w.webResults.find((r) => r.match.test(msg))
      results = hit ? [...hit.results] : [`Web search ran. No directly relevant page found for: ${msg.slice(0, 80)}`]
    }
    return jres({ results })
  }

  /* proposals / drafts / browser / purchase */
  if (p === '/api/internal/propose') {
    const kind = String(body.kind || (body.to ? 'mail' : body.start ? 'event' : 'unknown'))
    const fx = w.fx.propose || 'ok'
    if (fx === 'throw') throw new Error('propose provider timeout')
    if (fx === 'fail500') return jres({ ok: false, error: 'provider unavailable' }, 500)
    if (fx === 'no_id') return jres({ ok: true })
    if (w.fx.proposeResponse) return jres(w.fx.proposeResponse)
    if (kind === 'purchase') {
      bucket<Json>(w, 'drafts').push({ kind, ...body })
      bucket<Json>(w, 'spendApprovals').push({ id: 'req_1', item: body.title, amount: body.amount, state: 'pending_approval' })
      return jres({ ok: true, id: 'spend_1', requestId: 'req_1', approvalUrl: 'https://audit.internal/approve/req_1' })
    }
    if (kind === 'browser') {
      bucket<Json>(w, 'browserTasks').push({ ...body })
      return jres({ ok: true, id: 'job_1', requestId: 'req_1', origin: String(body.url || ''), sessionUrl: 'https://audit.internal/computer/job_1' })
    }
    bucket<Json>(w, 'drafts').push({ kind, ...body })
    return jres({ ok: true, id: `draft_${w.created.drafts.length}`, kind })
  }
  if (p === '/api/internal/mail/send') {
    bucket<Json>(w, 'drafts').push({ kind: 'mail_send', ...body })
    return jres({ ok: true, id: 'sent_1', providerId: 'smtp_1' })
  }
  if (p === '/api/internal/spend/decide') {
    const fx = w.fx.spendDecide || 'succeed'
    bucket<Json>(w, 'spendDecisions').push({ ...body })
    /* A DENY is a cancellation, not a charge. The old mock returned the
     * success shape for both decisions, which made mi3 report "merchant order
     * already placed" for a cancelled request — a HARNESS defect. */
    if (body.decision === 'deny') {
      if (w.created.spendApprovals?.[0]) w.created.spendApprovals[0].state = 'cancelled'
      return jres({ ok: true, state: 'cancelled', decision: 'denied' })
    }
    if (w.created.spendApprovals?.[0]) {
      w.created.spendApprovals[0].state = fx === 'succeed' ? 'succeeded' : fx === 'charged_false' ? 'succeeded' : 'outcome_unknown'
    }
    if (fx === 'throw') throw new Error('spend provider timeout after commit')
    if (fx === 'fail500') return jres({ ok: false, error: 'payment service down' }, 500)
    if (fx === 'charged_false') return jres({ ok: true, state: 'succeeded', charged: false })
    return jres({ ok: true, state: 'succeeded', charged: true, paymentIntentId: 'pi_audit_1', decision: 'approved' })
  }
  if (p === '/api/internal/browser/awaiting') return jres({ waiting: false, question: null, jobId: null })
  if (p === '/api/internal/browser/answer') return jres({ ok: true, answered: true })
  if (p === '/api/internal/browser/last') return jres({ run: null })
  if (p === '/api/internal/browser/task') {
    bucket<Json>(w, 'browserTasks').push({ ...body })
    return jres({ ok: true, id: 'job_2' })
  }

  /* memory */
  if (p === '/api/internal/memory') {
    if (method === 'DELETE') { bucket<Json>(w, 'memoryDeletes').push({ ...body }); return jres({ ok: true, key: body.key }) }
    bucket<Json>(w, 'memoryWrites').push(...(Array.isArray(body.facts) ? body.facts : [body]))
    return jres({ ok: true, dropped: [] })
  }

  /* reminders */
  if (p === '/api/internal/reminders' && method === 'POST') {
    if ((w.fx.reminder || 'ok') === 'fail500') return jres({ ok: false, error: 'reminder provider down' }, 500)
    bucket<Json>(w, 'reminders').push({ ...body })
    return jres({ ok: true, id: `rem_${w.created.reminders.length}` })
  }
  if (p === '/api/internal/reminders/list') {
    return jres({ reminders: w.created.reminders.map((r, i) => ({ id: `rem_${i + 1}`, text: r.text || r.body, scheduled_at: r.send_at || r.at || r.scheduled_at, recurrence: 'once', status: 'pending' })) })
  }
  if (p.startsWith('/api/internal/reminders/') && p.endsWith('/done')) return jres({ ok: true })
  if (p === '/api/internal/reminders/due') return jres({ reminders: [] })

  /* scheduled texts + loops + commitments */
  if (p === '/api/internal/scheduled_texts' && method === 'POST') {
    if ((w.fx.scheduledText || 'ok') === 'fail500') return jres({ ok: false, error: 'scheduler down' }, 500)
    bucket<Json>(w, 'scheduledTexts').push({ ...body })
    return jres({ ok: true, id: `st_${w.created.scheduledTexts.length}` })
  }
  if (p === '/api/internal/commitments') {
    bucket<Json>(w, 'commitments').push({ ...body })
    return jres({ ok: true, id: 'loop_c1' })
  }
  if (p === '/api/internal/loops' && method === 'POST') {
    bucket<Json>(w, 'loops').push({ ...body })
    return jres({ ok: true, id: 'loop_1' })
  }
  if (p === '/api/internal/loops/watch') {
    bucket<Json>(w, 'watches').push({ ...body })
    return jres({ ok: true, id: 'watch_1' })
  }
  if (p === '/api/internal/loops/result') return jres({ ok: true })

  /* calendar */
  if (p === '/api/internal/work/slots') {
    if (w.fx.calendarSlots === 'fail500') return jres({ error: 'down' }, 500)
    return jres({ slots: w.freeSlots, connect: false, unavailable: false })
  }
  if (p === '/api/internal/calendar/event') {
    bucket<Json>(w, 'calendarMutations').push({ ...body })
    return jres({ ok: true, event: { id: 'evt_1' } })
  }

  /* files */
  if (p === '/api/internal/files/search') {
    const q = String(body.query || '').toLowerCase()
    const files = w.drive.filter((d) => d.name.toLowerCase().includes(q.split(/\s+/)[0] || ''))
    return jres({ status: files.length ? 'success_with_data' : 'success_empty', files })
  }
  if (p === '/api/internal/files/send') {
    bucket<Json>(w, 'fileSends').push({ ...body })
    return jres({ ok: true, receipt: { providerId: 'msg_file_1' } })
  }

  /* work writes */
  if (p === '/api/internal/work/write') {
    bucket<Json>(w, 'workWrites').push({ ...body })
    return jres({ ok: true, output: 'Done. Created successfully.' })
  }
  if (p === '/api/internal/mail/context') return jres({ mail: w.mail })
  if (p === '/api/internal/network') return jres({ contacts: w.contacts })
  if (p === '/api/internal/spending') return jres(w.spending)

  /* bundles */
  if (p === '/api/internal/prep') return jres({ ok: false, error: 'none' }, 404)
  if (p === '/api/internal/week') return jres({ ok: false }, 404)
  if (p === '/api/internal/tasks/offer') {
    bucket<Json>(w, 'taskChoices').push({ ...body })
    return jres({ ok: true, taskId: 'task_1', rendered: '1) ' + String(body.candidates?.[0]?.title || 'A') + '\n2) ' + String(body.candidates?.[1]?.title || 'B') })
  }
  if (p === '/api/internal/tasks/choose') return jres({ ok: true, chosen: 0 })
  if (p === '/api/internal/email_followups' && method === 'POST') {
    bucket<Json>(w, 'followups').push({ ...body })
    return jres({ ok: true, followup: { id: 'fu_1' } })
  }
  if (p === '/api/internal/todos') { bucket<Json>(w, 'todos').push({ ...body }); return jres({ ok: true }) }

  /* life logging */
  if (p === '/api/internal/nutrition') return jres({ ok: true, logged: true, estimated: true, guess: String(body.description || 'meal').slice(0, 40), calories: 700, protein: 40, carbs: 60, fat: 25 })
  if (p === '/api/internal/sleep') return jres({ ok: true, logged: true })
  if (p === '/api/internal/workouts') return jres({ ok: true, logged: true })
  if (p === '/api/internal/moods') return jres({ ok: true, logged: true })
  if (p === '/api/internal/gratitude') return jres({ ok: true, logged: true })
  if (p === '/api/internal/habits/done') return jres({ ok: true })
  if (p === '/api/internal/budget' || p === '/api/internal/prefs') { bucket<Json>(w, 'otherWrites').push({ path: p, ...body }); return jres({ ok: true }) }
  if (p === '/api/internal/decisions' || p === '/api/internal/pipeline' || p === '/api/internal/learning' || p === '/api/internal/travel' || p === '/api/internal/standup') {
    bucket<Json>(w, 'otherWrites').push({ path: p, ...body }); return jres({ ok: true })
  }

  /* misc plumbing */
  if (p === '/api/internal/mini/token') return jres({ url: 'https://audit.internal/card/x' })
  if (p === '/api/internal/mini/run') return jres({}, 404)
  if (p.startsWith('/api/internal/workshop')) {
    bucket<Json>(w, 'otherWrites').push({ path: p, ...body })
    return jres({ ok: true, artifactId: 'art_1', url: 'https://audit.internal/b/art_1' })
  }
  if (p === '/api/internal/message-log' || p === '/api/internal/touch' || p === '/api/internal/heartbeat' || p === '/api/internal/proactive' || p === '/api/internal/handoff' || p === '/api/internal/kill-switch/check' || p === '/api/internal/intros/ack' || p === '/api/internal/subscriptions') {
    return jres({ ok: true, kill: false, enabled: false })
  }

  bucket<Json>(w, 'otherWrites').push({ path: p, ...body })
  return jres({ ok: true })
}

/* ---------- time simulation ---------- */

function ageThread(dataDir: string, senderId: string, days: number) {
  const safe = senderId.replace(/[^\d+a-zA-Z_-]/g, '_')
  const path = join(dataDir, 'threads', `${safe}.json`)
  if (!existsSync(path)) return
  const j = JSON.parse(readFileSync(path, 'utf8'))
  const back = days * 24 * 3600 * 1000
  for (const m of j.history || []) if (typeof m.ts === 'number') m.ts -= back
  for (const f of j.facts || []) {
    if (typeof f.ts === 'number') f.ts -= back
    if (typeof f.lastSeen === 'number') f.lastSeen -= back
  }
  writeFileSync(path, JSON.stringify(j, null, 2))
}

function readThreadFacts(dataDir: string, senderId: string): Json {
  const safe = senderId.replace(/[^\d+a-zA-Z_-]/g, '_')
  const path = join(dataDir, 'threads', `${safe}.json`)
  if (!existsSync(path)) return {}
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    return { facts: j.facts, summary: j.summary, historyCount: (j.history || []).length, pendingSpend: j.pendingSpend, pendingVaultTask: j.pendingVaultTask, pendingConnection: j.pendingConnection }
  } catch { return {} }
}

/* ---------- runner ---------- */

export interface TurnResult {
  text: string
  bubbles: string[]
  reply: string
  source: string
  card: string | null
  calls: Array<{ method: string; path: string; body: Json }>
  llmCallsInTurn: number
  claimViolations: number
  thread: Json
}

export interface ScenarioResult {
  revision: string
  model: string
  worldDefinition: unknown
  id: string
  cat: string
  title: string
  agent: string
  turns: TurnResult[]
  created: World['created']
  finalMemories: Array<{ key: string; value: string }>
  llmCalls: number
  wallMs: number
  error?: string
  requiredSources?: string[]
}

export async function runScenario(sc: Scenario): Promise<ScenarioResult> {
  CURRENT = null
  LLM_CALLS = 0
  const w: World = {
    id: sc.id, fx: {}, calls: [],
    created: { drafts: [], reminders: [], scheduledTexts: [], commitments: [], memoryWrites: [], memoryDeletes: [], spendDecisions: [], browserTasks: [], followups: [], calendarMutations: [], fileSends: [], workWrites: [], taskChoices: [], watches: [], anchors: [], plans: [], cancels: [], spendApprovals: [], todos: [], loops: [], otherWrites: [] },
    ...sc.world(),
  } as World
  const dataDir = join(OUT, 'data_' + sc.id)
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
  CURRENT = w
  /* Verified-completion fixture: the observed provider state for this
   * scenario feeds the engine's evidence parser exactly like a real
   * browser read-back would. */
  const worldWithObserved = w as unknown as { observed?: string }
  setCompletionObserver((text, kind) => {
    void text
    return worldWithObserved.observed || ''
  })
  const t0 = Date.now()
  let revision = 'unknown'
  try {
    revision = new TextDecoder().decode(
      Bun.spawnSync({ cmd: ['git', 'rev-parse', 'HEAD'], cwd: join(import.meta.dir, '../..') }).stdout,
    ).trim() || 'unknown'
  } catch { /* not a git tree */ }
  const result: ScenarioResult = {
    revision,
    model: process.env.GMI_MODEL || process.env.HIREALPHA_MODEL || 'unknown',
    worldDefinition: sc.world ? sc.world() : {},
    id: sc.id, cat: sc.cat, title: sc.title, agent: sc.agent || 'friend', turns: [], created: w.created, finalMemories: w.profile.memories, llmCalls: 0, wallMs: 0,
  }
  try {
    for (const t of sc.turns) {
      if (t.w) t.w(w)
      const llmBefore = LLM_CALLS
      const violationsBefore = claimViolationCount()
      const callMark = w.calls.length
      let res: Awaited<ReturnType<typeof runHireTurn>>
      try {
        res = await runHireTurn({
          agentId: (sc.agent || 'friend') as 'friend' | 'coworker' | 'cofounder',
          dataDir,
          senderId: w.profile.phone,
          userText: t.text,
          inboundNote: t.note,
          delivery: { onProgress: async () => {} },
        })
      } catch (err) {
        result.turns.push({ text: t.text, bubbles: [], reply: `HARNESS-ERROR: ${err instanceof Error ? err.message : String(err)}`, source: 'error', card: null, calls: w.calls.slice(callMark), llmCallsInTurn: LLM_CALLS - llmBefore, thread: {} })
        result.error = err instanceof Error ? err.message : String(err)
        break
      }
      result.turns.push({
        text: t.text,
        bubbles: res.bubbles.length ? res.bubbles : [res.reply],
        reply: res.reply,
        source: res.source,
        card: typeof res.card === 'string' ? res.card : res.card ? String((res.card as Json).url || JSON.stringify(res.card).slice(0, 120)) : null,
        calls: w.calls.slice(callMark).map((c) => ({ method: c.method, path: c.path, body: c.body })),
        llmCallsInTurn: LLM_CALLS - llmBefore,
        claimViolations: claimViolationCount() - violationsBefore,
        thread: readThreadFacts(dataDir, w.profile.phone),
      })
      if (t.ageDays) ageThread(dataDir, w.profile.phone, t.ageDays)
    }
  } finally {
    result.llmCalls = LLM_CALLS
    result.wallMs = Date.now() - t0
    if (sc.requiredSources) result.requiredSources = sc.requiredSources
    CURRENT = null
  }
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, `${sc.id}.json`), JSON.stringify(result, null, 2))
  return result
}

/** Compact digest for reading in a terminal — bubbles + state changes only. */
export function digest(r: ScenarioResult): string {
  const lines: string[] = []
  lines.push(`### ${r.id} [${r.cat}] ${r.title} — llm=${r.llmCalls} ms=${r.wallMs}${r.error ? ' ERROR=' + r.error : ''}`)
  for (const t of r.turns) {
    lines.push(`  USER> ${t.text}`)
    for (const b of t.bubbles) lines.push(`  ALPHA> ${b.replace(/\s+/g, ' ').slice(0, 400)}`)
    const notable = t.calls.filter((c) => !/touch|message-log|heartbeat|kill-switch|browser\/awaiting|browser\/last/.test(c.path))
    for (const c of notable) {
      const b = JSON.stringify(c.body).replace(/\s+/g, ' ').slice(0, 260)
      lines.push(`    CALL ${c.method} ${c.path.replace(/\?.*/, '')} ${b}`)
    }
    if (t.card) lines.push(`    CARD ${t.card}`)
  }
  const facts = r.finalMemories.map((m) => `${m.key}=${String(m.value).slice(0, 60)}`).join('; ')
  if (facts) lines.push(`  SERVER-MEM> ${facts}`)
  return lines.join('\n')
}

export function resetOut() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
}
