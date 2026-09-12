/**
 * Bench harness core — run the REAL production turn engine headlessly so a
 * benchmark dimension can be exercised and re-run while it is being fixed.
 *
 * Everything external is real: the same runHireTurn the bots run, GMI (with the
 * production model), the production API, live Composio connectors, and real
 * browser-job staging. Delivery is captured, never sent — no iMessage goes out.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

export function loadEnvFile(file: string, force = false) {
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (force || !process.env[key]) process.env[key] = val
  }
}

/** Point the engine at production and pin the model the bot actually runs.
 * Bun auto-loads ./.env and ./spectrum/alpha/.env before this file runs, so a
 * dev-only model can win the read; a harness that measures a different model
 * measures nothing. */
export function loadBenchEnv() {
  loadEnvFile(join(ROOT, 'spectrum', 'alpha', 'bench-runtime.env'), true)
  process.env.HIREALPHA_API_URL ||= 'https://hirealpha.chat'
  process.env.HIREALPHA_TOOL_LOOP_MS ||= '240000'
  const PROD_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731'
  process.env.GMI_MODEL = PROD_MODEL
  process.env.GMI_MODEL_FALLBACK ||= 'Qwen/Qwen3.8-Flash'
}

export type BenchRecord = {
  dim: string
  phone: string
  userText: string
  bubbles: string[]
  reply: string
  source: string
  card: { url: string; live: boolean } | null
  progress: string[]
  reactions: string[]
  totalMs: number
}

export async function benchTurn(opts: {
  dim: string
  phone: string
  userText: string
  dataDir: string
  trace?: boolean
  runHireTurn: (input: Record<string, unknown>) => Promise<{
    bubbles: string[]
    reply: string
    source: string
    card?: { url: string; live: boolean } | null
    contactCardFirst?: boolean
  }>
}): Promise<BenchRecord> {
  mkdirSync(opts.dataDir, { recursive: true })
  if (opts.trace) {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('/api/internal/')) return realFetch(input, init)
      const body = String(init?.body || '').slice(0, 220)
      const t0 = Date.now()
      const res = await realFetch(input, init)
      const text = await res.clone().text().catch(() => '')
      console.error(
        `[trace] ${url.replace(/^https?:\/\/[^/]+/, '')} <- ${body} => ${res.status} ${Date.now() - t0}ms ${text.slice(0, 400).replace(/\n/g, ' | ')}`,
      )
      return res
    }) as typeof fetch
  }

  const progress: string[] = []
  const reactions: string[] = []
  const started = Date.now()
  const result = await opts.runHireTurn({
    agentId: 'friend',
    dataDir: opts.dataDir,
    senderId: opts.phone,
    userText: opts.userText,
    delivery: {
      onProgress: async (text: string) => {
        progress.push(text)
      },
      onReaction: async (reaction: string) => {
        reactions.push(reaction)
      },
    },
  })

  const record: BenchRecord = {
    dim: opts.dim,
    phone: opts.phone,
    userText: opts.userText,
    bubbles: result.bubbles,
    reply: result.reply,
    source: result.source,
    card: result.card ? { url: result.card.url, live: result.card.live } : null,
    progress,
    reactions,
    totalMs: Date.now() - started,
  }
  const file = join(opts.dataDir, `last-turn-dim${opts.dim}.json`)
  writeFileSync(file, JSON.stringify(record, null, 2))
  return record
}
