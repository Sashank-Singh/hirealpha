/**
 * Simulate a group thread without needing four phones.
 *
 * The bot's group handling does two things a one-to-one turn does not: it
 * resolves the account holder and records each turn with the speaker's name in
 * front (`groupTurnLine`), and it hands the model a note about the room
 * (`groupTurnNote`). Both are inputs to runHireTurn, so a group can be driven
 * here exactly as the bot would drive it — same engine, same API, same model,
 * nothing texted — and the replies read back in order.
 *
 *   bun run scripts/bench-group.ts "find a dinner date everyone can make"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/* Same environment contract as bench-turn.ts: without the API base and the
 * internal key the engine silently takes its OFFLINE branch, runs a local
 * Playwright session and hands back a "task_…" session link the server will
 * 404 on — which reads exactly like a fabricated run. Load what the bot
 * loads, and let BENCH_API_URL point it at the local stack. */
for (const file of ['spectrum/alpha/.env', 'spectrum/alpha/bench-runtime.env']) {
  const path = join(ROOT, file)
  if (!existsSync(path)) continue
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim()
  }
}
process.env.HIREALPHA_API_URL ||= 'https://hirealpha.chat'
if (process.env.BENCH_API_URL) process.env.HIREALPHA_API_URL = process.env.BENCH_API_URL
/* Same guard as bench-turn: a rehearsal must not write facts to the real
 * account (see BENCH_NO_PERSIST there). */
process.env.BENCH_NO_PERSIST = process.env.BENCH_NO_PERSIST || '1'
{
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).includes('/api/internal/memory')) {
      return new Response(JSON.stringify({ ok: true, stored: [], dropped: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return realFetch(input, init)
  }) as typeof fetch
}

const { groupTurnLine, groupTurnNote } = await import('../spectrum/shared/groupChat')
const { runHireTurn } = await import('../spectrum/shared/runHireTurn')

const OWNER = process.env.BENCH_PHONE || '+12163032166'
const SPACE = `group:bench-${Date.now()}`
const DATA = join(ROOT, 'testbed', 'bench-data', 'group')

const ask = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] || 'Find a dinner date everyone can make'

const MEMBERS = [
  { id: '+15550001111', name: 'Sam' },
  { id: '+15550002222', name: 'Priya' },
  { id: '+12163032166', name: 'Sashank' },
  { id: '+15550003333', name: 'Dev' },
]

const SCRIPT: Array<{ speaker: string; text: string }> = [
  { speaker: 'Sashank', text: ask },
  { speaker: 'Sam', text: 'Any night but Wednesday for me' },
  { speaker: 'Priya', text: 'Thursday or Friday works' },
  { speaker: 'Dev', text: 'Thursday is good' },
  { speaker: 'Sashank', text: 'Thursday works for me too, book it for four' },
]

mkdirSync(join(DATA, 'threads'), { recursive: true })
const transcript: Array<{ speaker: string; said: string; reply: string; ms: number }> = []

for (const turn of SCRIPT) {
  const note = groupTurnNote({
    spaceType: 'group',
    members: MEMBERS,
    speakerId: MEMBERS.find((m) => m.name === turn.speaker)?.id,
    speakerName: turn.speaker,
  })
  const started = Date.now()
  const result = await runHireTurn({
    agentId: 'friend',
    dataDir: DATA,
    senderId: OWNER,
    userText: turn.text,
    threadLine: groupTurnLine(turn.speaker, turn.text),
    ...(note ? { inboundNote: note } : {}),
    delivery: { onProgress: async () => {}, onReaction: async () => {} },
  })
  transcript.push({ speaker: turn.speaker, said: turn.text, reply: result.reply, ms: Date.now() - started })
  console.log(`\n[${turn.speaker}] ${turn.text}\n  → ${result.reply.replace(/\n+/g, ' ').slice(0, 400)}`)
}

writeFileSync(join(DATA, 'last-group.json'), JSON.stringify({ space: SPACE, asked: ask, transcript }, null, 2))
console.log(`\n[bench-group] wrote ${join(DATA, 'last-group.json')}`)
