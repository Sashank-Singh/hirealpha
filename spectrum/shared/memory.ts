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
  /^(preferred_name|people|timezone|check_ins|company|role_title|projects|standup_time|company_name|stage|weekly_focus|hard_nos|diet|seat_preference|flight_preference|name|sister|partner|city|this_weeks_decision|tone_playfulness)|^bit[-_]|^(people|name|sister|partner|family|company|weekly|timezone|diet|seat)/i

export function isDurableFactKey(key: string) {
  return DURABLE_KEY.test(key)
}

/** Running bits and the tone dial, grouped for the selector. */
export function isBitFactKey(key: string) {
  return /^bit[-_]/i.test(key.trim())
}

export function isToneFactKey(key: string) {
  return /^tone_playfulness$/i.test(key.trim())
}

export interface MemoryFact {
  key: string
  value: string
  ts: number
  /** epoch ms the fact was last re-confirmed; drives expiry. */
  lastSeen: number
}

export interface ThreadMemory {
  pendingConnection?: { connector: string; request: string; createdAt: number }
  pendingVaultTask?: {
    id: string
    portal: string
    goal: string
    originalText: string
    createdAt: number
    state: 'pending' | 'preparing' | 'retryable_failure'
    lastError?: string
  }
  pendingSpend?: { id: string; item: string; amount: number; url?: string; createdAt: number }
  /** The build most recently delivered in this thread, so keep/toss/iterate act
   * on the app the user is actually talking about. */
  lastBuild?: { artifactId: string; url: string }
  lastCardDeliveredAt?: number
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

const createEmpty = (): ThreadMemory => ({ facts: [], summary: '', history: [] })

function normalize(raw: unknown): ThreadMemory {
  if (!raw || typeof raw !== 'object') return createEmpty()
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
    ...(r.pendingConnection && typeof r.pendingConnection === 'object' &&
      typeof (r.pendingConnection as Record<string, unknown>).connector === 'string' &&
      typeof (r.pendingConnection as Record<string, unknown>).request === 'string' &&
      typeof (r.pendingConnection as Record<string, unknown>).createdAt === 'number'
      ? { pendingConnection: r.pendingConnection as ThreadMemory['pendingConnection'] } : {}),
    ...(r.pendingVaultTask && typeof r.pendingVaultTask === 'object' &&
      typeof (r.pendingVaultTask as Record<string, unknown>).portal === 'string' &&
      typeof (r.pendingVaultTask as Record<string, unknown>).goal === 'string' &&
      typeof (r.pendingVaultTask as Record<string, unknown>).createdAt === 'number'
      ? { pendingVaultTask: {
          ...(r.pendingVaultTask as Omit<NonNullable<ThreadMemory['pendingVaultTask']>, 'id' | 'state'>),
          id: typeof (r.pendingVaultTask as Record<string, unknown>).id === 'string'
            ? String((r.pendingVaultTask as Record<string, unknown>).id) : crypto.randomUUID(),
          state: ['pending', 'preparing', 'retryable_failure'].includes(String((r.pendingVaultTask as Record<string, unknown>).state))
            ? (r.pendingVaultTask as NonNullable<ThreadMemory['pendingVaultTask']>).state : 'pending',
        } } : {}),
    ...(r.pendingSpend && typeof r.pendingSpend === 'object' &&
      typeof (r.pendingSpend as Record<string, unknown>).id === 'string'
      ? { pendingSpend: r.pendingSpend as ThreadMemory['pendingSpend'] } : {}),
    ...(r.lastBuild && typeof r.lastBuild === 'object' &&
      typeof (r.lastBuild as Record<string, unknown>).artifactId === 'string'
      ? { lastBuild: r.lastBuild as ThreadMemory['lastBuild'] } : {}),
    ...(typeof r.lastCardDeliveredAt === 'number' ? { lastCardDeliveredAt: r.lastCardDeliveredAt } : {}),
    facts,
    summary: typeof r.summary === 'string' ? r.summary : '',
    history,
  }
}

export function loadMemory(dataDir: string, senderId: string): ThreadMemory {
  const path = threadPath(dataDir, senderId)
  if (!existsSync(path)) return createEmpty()
  try {
    return normalize(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return createEmpty()
  }
}

function writeMemory(dataDir: string, senderId: string, mem: ThreadMemory) {
  const path = threadPath(dataDir, senderId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(mem, null, 2))
}

export function setPendingConnection(dataDir: string, senderId: string, pending?: ThreadMemory['pendingConnection']) {
  const mem = { ...loadMemory(dataDir, senderId) }
  if (pending) mem.pendingConnection = pending
  else delete mem.pendingConnection
  writeMemory(dataDir, senderId, mem)
}

export function setPendingVaultTask(dataDir: string, senderId: string, pending?: ThreadMemory['pendingVaultTask']) {
  const mem = { ...loadMemory(dataDir, senderId) }
  if (pending) mem.pendingVaultTask = pending
  else delete mem.pendingVaultTask
  writeMemory(dataDir, senderId, mem)
}

/** The key a delivered build is mirrored under: `<artifactId>|<url>`. */
export const LAST_BUILD_KEY = 'last_build_url'

/** The build this thread was last given: the thread file first, then the
 * durable fact, which is the only copy that survives a container swap and is
 * re-hydrated from the live payload on the next turn. Live, 2026-09-19: a game
 * was delivered, the next deploy replaced the container, and the follow-up
 * "add a 30 second timer to the game" was refused — "there's no game in this
 * thread for me to update" — because both the /b/ link and the artifact id
 * lived only in the thread file. */
export function lastBuildFor(
  mem: ThreadMemory,
  liveMemories?: Array<{ key?: string; value?: string }>,
): { artifactId: string; url: string } | undefined {
  if (mem.lastBuild?.artifactId && mem.lastBuild.url) return mem.lastBuild
  const raw = [...mem.facts, ...(liveMemories || [])]
    .reverse()
    .find((f) => String(f.key || '').toLowerCase() === LAST_BUILD_KEY)?.value
  const [artifactId, url] = String(raw || '').split('|')
  return artifactId && url ? { artifactId, url } : undefined
}

/** Record a delivered build in both local stores. Every delivery path must call
 * this: the workshop's own turn did, the `build` capability did not — and that
 * capability is the path a plain "make me a dice roller" actually takes, so the
 * mirror written by the turn never happened and the next change request had
 * nothing to iterate. The durable (server) copy is the caller's job, since it
 * holds the persona and the API client. */
export function recordDeliveredBuild(
  dataDir: string,
  senderId: string,
  build: { artifactId: string; url: string },
): void {
  setLastBuild(dataDir, senderId, build)
  upsertFacts(dataDir, senderId, [
    { key: LAST_BUILD_KEY, value: `${build.artifactId}|${build.url}`, ts: Date.now(), lastSeen: Date.now() },
  ])
}

/** The build Alpha most recently delivered in this thread. Keep, toss and
 * iterate all used to act on "the newest delivered row", which is a different
 * build the moment the user has two — "keep it" about the older app kept the
 * newer one and the app they were using still expired. */
export function setLastBuild(dataDir: string, senderId: string, build?: { artifactId: string; url: string }) {
  const mem = { ...loadMemory(dataDir, senderId) }
  if (build) mem.lastBuild = build
  else delete mem.lastBuild
  writeMemory(dataDir, senderId, mem)
}

export function setPendingSpend(dataDir: string, senderId: string, pending?: ThreadMemory['pendingSpend']) {
  const mem = { ...loadMemory(dataDir, senderId) }
  if (pending) mem.pendingSpend = pending
  else delete mem.pendingSpend
  writeMemory(dataDir, senderId, mem)
}

export function recordCardDelivered(dataDir: string, senderId: string, ts = Date.now()): void {
  const mem = { ...loadMemory(dataDir, senderId) }
  mem.lastCardDeliveredAt = ts
  writeMemory(dataDir, senderId, mem)
}

/** Backwards-compat: raw history only. */
export function loadThread(dataDir: string, senderId: string): ChatMessage[] {
  return loadMemory(dataDir, senderId).history
}

/** Append messages (timestamped), trimming the raw tail. */
export function appendThread(
  dataDir: string,
  senderId: string,
  messages: ChatMessage[],
): ThreadMemory {
  const mem = loadMemory(dataDir, senderId)
  const now = Date.now()
  const stamped: ChatMessage[] = messages.map((m) => ({ ...m, ts: m.ts ?? now }))
  const next: ThreadMemory = {
    ...mem,
    history: [...mem.history, ...stamped].slice(-MAX_RAW),
  }
  writeMemory(dataDir, senderId, next)
  return next
}

/** Upsert durable facts. Re-mention drags `lastSeen` forward for expiry. */
/** Drop facts by key — the local half of a deletion made on the server. Returns
 * the keys actually removed. */
export function removeFacts(dataDir: string, senderId: string, keys: string[]): string[] {
  const wanted = new Set(keys.map((k) => String(k).toLowerCase()))
  if (!wanted.size) return []
  const mem = loadMemory(dataDir, senderId)
  const kept = mem.facts.filter((f) => !wanted.has(f.key.toLowerCase()))
  if (kept.length === mem.facts.length) return []
  const removed = mem.facts.filter((f) => wanted.has(f.key.toLowerCase())).map((f) => f.key)
  writeMemory(dataDir, senderId, { ...mem, facts: kept })
  return removed
}

export function upsertFacts(
  dataDir: string,
  senderId: string,
  facts: MemoryFact[],
): ThreadMemory {
  const mem = loadMemory(dataDir, senderId)
  const now = Date.now()
  const byKey = new Map(mem.facts.map((f) => [f.key, f]))
  for (const f of facts) {
    if (!f.key || !f.value) continue
    /* Re-stating a preference moves it back to the newest position: the array
     * is insertion-ordered and the prompt takes its tail, so a fact the user
     * repeats weekly used to age toward eviction anyway. */
    byKey.delete(f.key)
    byKey.set(f.key, { key: f.key, value: f.value, ts: now, lastSeen: now })
  }
  const next: ThreadMemory = {
    ...mem,
    facts: [...byKey.values()].slice(-MAX_FACTS),
  }
  writeMemory(dataDir, senderId, next)
  return next
}

/** Drop facts not re-confirmed within FACT_TTL_DAYS. Names, people, timezone, and this week's decision never expire. */
export function pruneExpiredFacts(
  dataDir: string,
  senderId: string,
): ThreadMemory {
  const mem = loadMemory(dataDir, senderId)
  const cutoff = Date.now() - FACT_TTL_DAYS * 24 * 60 * 60 * 1000
  const facts = mem.facts.filter(
    (f) => isDurableFactKey(f.key) || (f.lastSeen ?? f.ts) > cutoff,
  )
  if (facts.length === mem.facts.length) return mem
  const next: ThreadMemory = { ...mem, facts }
  writeMemory(dataDir, senderId, next)
  return next
}

/** Replace the rolling summary. */
export function setSummary(
  dataDir: string,
  senderId: string,
  summary: string,
): ThreadMemory {
  const mem = loadMemory(dataDir, senderId)
  const next: ThreadMemory = { ...mem, summary }
  writeMemory(dataDir, senderId, next)
  return next
}

/** Drop older raw messages that have already been folded into the summary. */
export function trimHistory(
  dataDir: string,
  senderId: string,
  keepLast: number,
): ThreadMemory {
  const mem = loadMemory(dataDir, senderId)
  const next: ThreadMemory = { ...mem, history: mem.history.slice(-keepLast) }
  writeMemory(dataDir, senderId, next)
  return next
}
