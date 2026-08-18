import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatMessage } from '../../src/agents/types'

/** Max raw messages kept for coherence. Older ones are folded into `summary`. */
export const MAX_RAW = 20
/** Durable facts cap so the file can't grow unbounded. */
export const MAX_FACTS = 60
/** Drop a fact if it hasn't been re-confirmed in this many days. Durable keys never expire. */
export const FACT_TTL_DAYS = 30

const DURABLE_KEY =
  /^(preferred_name|people|timezone|check_ins|company|role_title|projects|standup_time|company_name|stage|weekly_focus|hard_nos|name|sister|partner|city|this_weeks_decision)|^(people|name|sister|partner|family|company|weekly|timezone)/i

export function isDurableFactKey(key: string) {
  return DURABLE_KEY.test(key)
}

export interface MemoryFact {
  key: string
  value: string
  ts: number
  /** epoch ms the fact was last re-confirmed; drives expiry. */
  lastSeen: number
}

export interface ThreadMemory {
  /** Durable facts about the person, never sliced by recency. */
  facts: MemoryFact[]
  /** Rolling summary of everything older than MAX_RAW. */
  summary: string
  /** Recent raw messages with timestamps. */
  history: ChatMessage[]
}

function threadPath(dataDir: string, senderId: string) {
  const safe = senderId.replace(/[^\d+a-zA-Z_-]/g, '_')
  return join(dataDir, 'threads', `${safe}.json`)
}

const EMPTY: ThreadMemory = { facts: [], summary: '', history: [] }

function normalize(raw: unknown): ThreadMemory {
  if (!raw || typeof raw !== 'object') return EMPTY
  const r = raw as Record<string, unknown>
  const facts: MemoryFact[] = []
  if (Array.isArray(r.facts)) {
    for (const f of r.facts as unknown[]) {
      if (f && typeof (f as { key?: unknown }).key === 'string' && typeof (f as { value?: unknown }).value === 'string') {
        const k = f as { key: string; value: string; ts?: number; lastSeen?: number }
        const ts = k.ts ?? Date.now()
        facts.push({ key: k.key, value: k.value, ts, lastSeen: k.lastSeen ?? ts })
      }
    }
  }
  const history = Array.isArray(r.history)
    ? (r.history as ChatMessage[]).filter(
        (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
      ).slice(-MAX_RAW)
    : []
  return {
    facts,
    summary: typeof r.summary === 'string' ? r.summary : '',
    history,
  }
}

/* ------------------------------------------------------------------ */
/* Remote-backed storage (Postgres via HireAlpha internal API)         */
/* ------------------------------------------------------------------ */

/** How long a remote fetch is allowed to take before we fall back to the file cache. */
const REMOTE_TIMEOUT_MS = 4000

function remoteConfigured() {
  return !!(process.env.HIREALPHA_API_URL && process.env.HIREALPHA_INTERNAL_KEY && process.env.HIREALPHA_BOT)
}

function remoteUrl(senderId: string) {
  const base = (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
  const params = new URLSearchParams({ persona: process.env.HIREALPHA_BOT || '', senderId })
  return `${base}/api/internal/thread-memory?${params}`
}

function remoteHeaders() {
  return {
    Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}`,
    'Content-Type': 'application/json',
  }
}

/**
 * In-process mirror of each thread. Seeded from the remote API (or the file
 * cache if the API is unreachable) on first access, then kept fresh by every
 * write. Reads never hit the network, so turns stay fast and consistent.
 */
const mirror = new Map<string, ThreadMemory>()

async function loadRemoteThread(senderId: string): Promise<ThreadMemory | null> {
  if (!remoteConfigured()) return null
  try {
    const res = await fetch(remoteUrl(senderId), {
      headers: remoteHeaders(),
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { thread?: unknown }
    return data.thread && typeof data.thread === 'object' ? (data.thread as ThreadMemory) : null
  } catch {
    return null
  }
}

async function saveRemoteThread(senderId: string, mem: ThreadMemory) {
  if (!remoteConfigured()) return
  try {
    const res = await fetch(remoteUrl(senderId), {
      method: 'PUT',
      headers: remoteHeaders(),
      body: JSON.stringify({ persona: process.env.HIREALPHA_BOT, senderId, thread: mem }),
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    })
    if (!res.ok) console.warn(`[memory] remote save failed (${res.status}); file cache retained`)
  } catch {
    console.warn('[memory] remote save failed; file cache retained')
  }
}

function readLocal(dataDir: string, senderId: string): ThreadMemory {
  const path = threadPath(dataDir, senderId)
  if (!existsSync(path)) return EMPTY
  try {
    return normalize(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return EMPTY
  }
}

function writeLocal(dataDir: string, senderId: string, mem: ThreadMemory) {
  const path = threadPath(dataDir, senderId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(mem, null, 2))
}

export async function loadMemory(dataDir: string, senderId: string): Promise<ThreadMemory> {
  const cached = mirror.get(senderId)
  if (cached) return cached
  const remote = await loadRemoteThread(senderId)
  if (remote) {
    const mem = normalize(remote)
    writeLocal(dataDir, senderId, mem)
    mirror.set(senderId, mem)
    return mem
  }
  const mem = readLocal(dataDir, senderId)
  mirror.set(senderId, mem)
  return mem
}

async function writeMemory(dataDir: string, senderId: string, mem: ThreadMemory) {
  writeLocal(dataDir, senderId, mem)
  mirror.set(senderId, mem)
  await saveRemoteThread(senderId, mem)
}

/** Backwards-compat: raw history only. */
export async function loadThread(dataDir: string, senderId: string): Promise<ChatMessage[]> {
  return (await loadMemory(dataDir, senderId)).history
}

/** Append messages (timestamped), trimming the raw tail. */
export async function appendThread(
  dataDir: string,
  senderId: string,
  messages: ChatMessage[],
): Promise<ThreadMemory> {
  const mem = await loadMemory(dataDir, senderId)
  const now = Date.now()
  const stamped: ChatMessage[] = messages.map((m) => ({ ...m, ts: m.ts ?? now }))
  const next: ThreadMemory = {
    ...mem,
    history: [...mem.history, ...stamped].slice(-MAX_RAW),
  }
  await writeMemory(dataDir, senderId, next)
  return next
}

/** Upsert durable facts. Re-mention drags `lastSeen` forward for expiry. */
export async function upsertFacts(
  dataDir: string,
  senderId: string,
  facts: MemoryFact[],
): Promise<ThreadMemory> {
  const mem = await loadMemory(dataDir, senderId)
  const now = Date.now()
  const byKey = new Map(mem.facts.map((f) => [f.key, f]))
  for (const f of facts) {
    if (!f.key || !f.value) continue
    byKey.set(f.key, { key: f.key, value: f.value, ts: now, lastSeen: now })
  }
  const next: ThreadMemory = {
    ...mem,
    facts: [...byKey.values()].slice(-MAX_FACTS),
  }
  await writeMemory(dataDir, senderId, next)
  return next
}

/** Drop facts not re-confirmed within FACT_TTL_DAYS. Names, people, timezone, and this week's decision never expire. */
export async function pruneExpiredFacts(
  dataDir: string,
  senderId: string,
): Promise<ThreadMemory> {
  const mem = await loadMemory(dataDir, senderId)
  const cutoff = Date.now() - FACT_TTL_DAYS * 24 * 60 * 60 * 1000
  const facts = mem.facts.filter(
    (f) => isDurableFactKey(f.key) || (f.lastSeen ?? f.ts) > cutoff,
  )
  if (facts.length === mem.facts.length) return mem
  const next: ThreadMemory = { ...mem, facts }
  await writeMemory(dataDir, senderId, next)
  return next
}

/** Replace the rolling summary. */
export async function setSummary(
  dataDir: string,
  senderId: string,
  summary: string,
): Promise<ThreadMemory> {
  const mem = await loadMemory(dataDir, senderId)
  const next: ThreadMemory = { ...mem, summary }
  await writeMemory(dataDir, senderId, next)
  return next
}

/** Drop older raw messages that have already been folded into the summary. */
export async function trimHistory(
  dataDir: string,
  senderId: string,
  keepLast: number,
): Promise<ThreadMemory> {
  const mem = await loadMemory(dataDir, senderId)
  const next: ThreadMemory = { ...mem, history: mem.history.slice(-keepLast) }
  await writeMemory(dataDir, senderId, next)
  return next
}
