/**
 * Bench harness — runs the REAL production turn engine without an iMessage
 * round trip, so a dimension can be exercised and re-run while it is being
 * fixed. Everything external is real: the same runHireTurn the bots run, GMI,
 * the production API, live Composio connectors, and browser-job staging.
 *
 *   bun run scripts/bench-turn.ts "book me a hotel in Chicago ..."
 *   bun run scripts/bench-turn.ts --dim 1 --file /tmp/task.txt
 *
 * Delivery is captured instead of sent: the reply is printed as JSON so a
 * caller (or an agent) can score it. Nothing is ever texted from here.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

function loadEnv(file: string, force = false) {
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

// Order matters: the repo .env holds the local dev model (Gemini), while the
// bench env carries what the production bot actually runs (DeepSeek V4 Flash).
// A harness that measures a different model measures nothing.
loadEnv(join(ROOT, 'spectrum', 'alpha', 'bench-runtime.env'), true)

// Bun auto-loads ./.env and ./spectrum/alpha/.env before this file runs, so a
// dev-only model can win the read. Pin what production runs.
const PROD_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731'
if (!/^deepseek/i.test(process.env.GMI_MODEL || '')) process.env.GMI_MODEL = PROD_MODEL

// Delivery is captured, so the harness never needs Photon. But runHireTurn and
// liveContext read the API base/key at call time; keep those pointed at prod.
process.env.HIREALPHA_API_URL ||= 'https://hirealpha.chat'
process.env.HIREALPHA_TOOL_LOOP_MS ||= '240000'

const args = process.argv.slice(2)
let userText = ''
let dim = ''
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dim') dim = args[++i] ?? ''
  else if (args[i] === '--file') userText = readFileSync(args[++i]!, 'utf8').trim()
  else if (!args[i]!.startsWith('--')) userText = args[i]!
}

if (!userText) {
  console.error('usage: bun run scripts/bench-turn.ts "<task text>" [--dim N]')
  process.exit(2)
}

const PHONE = process.env.BENCH_PHONE || '+12163032166'
const AGENT = (process.env.BENCH_AGENT || 'friend') as 'friend'
const DATA = join(ROOT, 'testbed', 'bench-data')
mkdirSync(DATA, { recursive: true })

// Trace every tool read the turn makes: a dimension that fails on "the lookup
// returned nothing" needs the actual payload to be debuggable.
if (process.env.BENCH_TRACE === '1') {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    if (!url.includes('/api/internal/')) return realFetch(input, init)
    const body = (() => {
      try {
        return String(init?.body || '').slice(0, 220)
      } catch {
        return ''
      }
    })()
    const t0 = Date.now()
    const res = await realFetch(input, init)
    const text = await res.clone().text().catch(() => '')
    console.error(`[trace] ${url.replace(/^https?:\/\/[^/]+/, '')} <- ${body} => ${res.status} ${Date.now() - t0}ms ${text.slice(0, 400).replace(/\n/g, ' | ')}`)
    return res
  }) as typeof fetch
}

const { runHireTurn } = await import('../spectrum/shared/runHireTurn')

const started = Date.now()
const progress: string[] = []
const reactions: string[] = []

const result = await runHireTurn({
  agentId: AGENT,
  dataDir: DATA,
  senderId: PHONE,
  userText,
  delivery: {
    onProgress: async (text) => {
      progress.push(text)
    },
    onReaction: async (reaction) => {
      reactions.push(reaction)
    },
  },
})

const out = {
  dim,
  phone: PHONE,
  userText,
  bubbles: result.bubbles,
  reply: result.reply,
  source: result.source,
  authoritative: result.authoritative,
  card: result.card ? { url: result.card.url, live: result.card.live } : null,
  contactCardFirst: result.contactCardFirst ?? false,
  progress,
  reactions,
  totalMs: Date.now() - started,
}

console.log(JSON.stringify(out, null, 2))
writeFileSync(join(DATA, `last-turn${dim ? `-dim${dim}` : ''}.json`), JSON.stringify(out, null, 2))
