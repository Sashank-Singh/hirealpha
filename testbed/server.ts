/**
 * Testbed — a local iMessage stand-in so bot behavior is testable without
 * deploying and texting the production thread.
 *
 * What is REAL here:
 *   - runHireTurn: the exact turn engine the bots run (memory files, tool
 *     loop, onboarding, briefs, stop-limits, outbound sanitizing).
 *   - GMI: real model calls (GMI_API_KEY from .env).
 *   - Web search: real DuckDuckGo via services/tools/searchWeb.
 *
 * What is FAKED (so nothing touches prod and every state is controllable):
 *   - The HireAlpha API: profile, connected tools, memories, mail/calendar
 *     reads, drafts, nutrition logs — fixtures in testbed/fixtures.json.
 *   - Delivery: bubbles stream into the local chat UI; nothing sends via
 *     iMessage. Mini-app cards open a local card panel.
 *
 * Run:  bun run testbed   →  http://localhost:5178
 * Reset memory with the button in the header (wipes testbed/data).
 */
import { searchWeb } from '../services/tools/search'
import { runHireTurn } from '../spectrum/shared/runHireTurn'
import type { MiniAppKind } from '../spectrum/shared/miniApps'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.TESTBED_PORT || 5178)
const ROOT = join(import.meta.dir)
const DATA = join(ROOT, 'data')
const FIXTURES = join(ROOT, 'fixtures.json')
const AGENT_ID = (process.env.TESTBED_AGENT || 'friend') as 'friend' | 'coworker' | 'cofounder'

mkdirSync(DATA, { recursive: true })

// The turn engine and liveContext read these at call time. Point them at this
// process (the shim answers /api/internal/*) and make the internal key exist.
process.env.HIREALPHA_API_URL = `http://localhost:${process.env.TESTBED_PORT || 5178}`
process.env.HIREALPHA_INTERNAL_KEY ||= 'testbed-internal-key'

interface Fixtures {
  phone: string
  name: string
  timezone: string
  hired: boolean
  connected: string[]
  memories: Array<{ key: string; value: string }>
  mail: Array<{ id: string; from: string; subject: string; snippet: string }>
  events: Array<{ title: string; when: string }>
  nutrition: { calories: number; protein: number; carbs: number; fat: number }
}

const DEFAULT_FIXTURES: Fixtures = {
  phone: '+1555TESTBED01',
  name: 'Sashank',
  timezone: 'America/Los_Angeles',
  hired: true,
  connected: ['gmail', 'calendar', 'drive'],
  memories: [{ key: 'preferred_name', value: 'Sashank' }],
  mail: [
    { id: 'm1', from: 'recruiter@bigco.com', subject: 'Quick call this week?', snippet: 'Saw your background — do you have 20 minutes Thursday?' },
    { id: 'm2', from: 'cal.com <no-reply@cal.com>', subject: 'Reminder: SVF Interview', snippet: 'This is a reminder about your upcoming event.' },
  ],
  events: [
    { title: 'SVF Interview', when: 'Mon Sep 8, 2:00 PM' },
    { title: 'Gym', when: 'Mon Sep 8, 6:30 PM' },
  ],
  nutrition: { calories: 640, protein: 42, carbs: 71, fat: 19 },
}

function loadFixtures(): Fixtures {
  try {
    if (existsSync(FIXTURES)) return { ...DEFAULT_FIXTURES, ...JSON.parse(readFileSync(FIXTURES, 'utf8')) }
  } catch {
    /* corrupted file falls back to defaults */
  }
  return { ...DEFAULT_FIXTURES }
}
function saveFixtures(f: Fixtures) {
  writeFileSync(FIXTURES, JSON.stringify(f, null, 2))
}

/* ---- The intercepted world ---- */

const realFetch = globalThis.fetch
let lastProfile: Record<string, unknown> | null = null

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input)

  // GMI + public internet stay real so model calls and search behave like prod.
  if (!url.includes('/api/internal/')) {
    if (url.includes('/chat/completions')) {
      const t0 = Date.now()
      let res: Response
      try {
        res = await realFetch(input, init)
      } catch (err) {
        console.log(`[testbed] completion THROW: ${err instanceof Error ? err.message : String(err)} (${Date.now() - t0}ms)`)
        throw err
      }
      console.log(`[testbed] completion ${res.status} ${Date.now() - t0}ms`)
      try {
        const clone = res.clone()
        const data = (await clone.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const sys = String(init?.body || '')
        const tag = /free live lookup/i.test(sys) ? 'CLASSIFY' : /CAPABILITY MANIFESTO/.test(sys) ? 'TURN' : /Pick at most one live tool/.test(sys) ? 'PICK' : 'AUX:'+sys.slice(0,60).replace(/\\n/g,' ')
        console.log(`[testbed] ${tag} → ${String(data.choices?.[0]?.message?.content || '').slice(0, 120).replace(/\n/g, ' ')}`)
      } catch { /* logging only */ }
      return res
    }
    return realFetch(input, init)
  }

  console.log(`[testbed] internal: ${url.slice(url.indexOf('/api/')).slice(0,60)}`)
  const f = loadFixtures()
  const body = (() => {
    try {
      return JSON.parse(String(init?.body || '{}'))
    } catch {
      return {} as Record<string, unknown>
    }
  })() as Record<string, unknown>

  if (url.includes('/api/internal/live?')) {
    lastProfile = {
      found: f.hired,
      hired: f.hired,
      userId: 'testbed-user',
      email: 'testbed@example.com',
      name: f.name,
      phone: f.phone,
      timezone: f.timezone,
      context: { timezone: f.timezone },
      connected: f.connected,
      memories: f.memories,
      unavailable: false,
    }
    return Response.json(lastProfile)
  }

  if (url.includes('/api/internal/live/tools')) {
    const want = String(body.want || '')
    console.log(`[testbed] tool call: want=${want} msg=${String(body.message||'').slice(0,60)}`)
    const message = String(body.message || '')
    if (want === 'web') {
      const results = await searchWeb(message.slice(0, 160), 5)
      return Response.json({
        results: [
          `Web results for "${message.slice(0, 80)}":`,
          ...results.map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet.slice(0, 160)}`),
        ],
      })
    }
    if (want === 'maps') {
      return Response.json({
        results: [
          'Nearby picks:',
          '- Foreign Cinema — 2430 California St, San Francisco. Busy but roomy patio, good for date night. https://www.openstreetmap.org/way/416051348',
          '- Beretta — 1199 Valencia St, San Francisco. Louder, great cocktails, walk-in friendly. https://www.openstreetmap.org/way/370534180',
        ],
      })
    }
    if (want === 'gmail') {
      return Response.json({
        results: f.mail.map((m) => `id=${m.id} from=${m.from} subject=${m.subject}. ${m.snippet}`),
      })
    }
    if (want === 'calendar') {
      return Response.json({
        results: f.events.map((e) => `${e.title} — ${e.when}`),
      })
    }
    if (want === 'drive') {
      return Response.json({ results: ['- Q3 Planning.docx (document) 2026-09-01'] })
    }
    return Response.json({ results: [] })
  }

  if (url.includes('/api/internal/memory')) {
    const entries = Array.isArray(body.memories) ? (body.memories as Fixtures['memories']) : []
    for (const e of entries) {
      const hit = f.memories.find((m) => m.key === e.key)
      if (hit) hit.value = e.value
      else f.memories.push(e)
    }
    saveFixtures(f)
    return Response.json({ ok: true })
  }

  if (url.includes('/api/internal/propose') || url.includes('/api/internal/mail/send')) {
    appendEvent({ kind: 'draft', detail: body })
    return Response.json({ ok: true, id: 'draft-testbed' })
  }

  if (url.includes('/api/internal/nutrition/photo')) {
    appendEvent({ kind: 'photo-log', detail: { note: 'logged with estimate pending (vision not run locally)' } })
    return Response.json({ ok: true, logged: true, estimated: false })
  }
  if (url.includes('/api/internal/nutrition')) {
    const n = f.nutrition
    appendEvent({ kind: 'nutrition-log', detail: body })
    return Response.json({ ok: true, logged: true, estimated: true, guess: String(body.description || 'meal').slice(0, 60), ...n })
  }
  if (url.includes('/api/internal/sleep')) {
    appendEvent({ kind: 'sleep-log', detail: body })
    return Response.json({ ok: true, logged: true, bedtime: '23:00', wake: '06:30' })
  }
  if (url.includes('/api/internal/workouts')) {
    appendEvent({ kind: 'workout-log', detail: body })
    return Response.json({ ok: true, logged: true, exercise: 'bench press', sets: 5, reps: 5, weight: 185 })
  }
  if (url.includes('/api/internal/mini/token')) {
    const kind = new URL(url, 'http://x').searchParams.get('kind') || 'home'
    return Response.json({ url: `http://localhost:${PORT}/card/${kind}` })
  }
  if (url.includes('/api/internal/reminders') || url.includes('/api/internal/reminders/')) {
    appendEvent({ kind: 'reminder', detail: body })
    return Response.json({ ok: true, id: 'rem-testbed' })
  }

  // Generic internal write: acknowledge and log so behavior is inspectable.
  appendEvent({ kind: 'internal', detail: { url: url.replace(/^https?:\/\/[^/]+/, ''), body } })
  return Response.json({ ok: true })
}) as typeof fetch

/* ---- Event log (drafts, logs, reminder writes) shown in the UI ---- */

const EVENTS_FILE = join(DATA, 'events.json')
function appendEvent(e: { kind: string; detail: unknown }) {
  const all = existsSync(EVENTS_FILE) ? JSON.parse(readFileSync(EVENTS_FILE, 'utf8')) : []
  all.push({ ts: new Date().toISOString(), ...e })
  writeFileSync(EVENTS_FILE, JSON.stringify(all.slice(-200), null, 2))
  broadcast({ type: 'event', event: { ts: new Date().toISOString(), ...e } })
}

/* ---- WebSocket chat ---- */

const clients = new Set<WebSocket>()
function broadcast(msg: unknown) {
  for (const ws of clients) {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      clients.delete(ws)
    }
  }
}

// Prod processes inbound serially per thread; a second text waits its turn
// instead of vanishing. FIFO here too — dropping differed from iMessage.
let queue: Promise<void> = Promise.resolve()
function enqueue(job: () => Promise<void>) {
  queue = queue.then(job).catch(() => undefined)
}
async function handleInbound(text: string, photo?: { bytes: Uint8Array; mime: string }) {
  return enqueue(async () => {
    await runTurn(text, photo)
  })
}
async function runTurn(text: string, photo?: { bytes: Uint8Array; mime: string }) {
  const f = loadFixtures()
  try {
    let userText = text.trim()
    let inboundNote: string | undefined
    if (photo) {
      // Same call the bot makes for an inbound image; the shim logs it.
      const { handleInboundPhoto } = await import('../spectrum/shared/liveContext')
      const content = { type: 'attachment', mimeType: photo.mime, read: async () => Buffer.from(photo.bytes) }
      const photoReply = await handleInboundPhoto(f.phone, AGENT_ID, content)
      if (photoReply) broadcast({ type: 'bubble', from: 'alpha', text: photoReply })
      inboundNote = photoReply
        ? `The user sent a food photo with this message. It was auto-logged to nutrition and you just confirmed it in one line ("${photoReply}"). Do not log it again; answer their actual question.`
        : undefined
      if (!userText && !photoReply) return
    }
    broadcast({ type: 'typing', on: true })
    const result = await runHireTurn({
      agentId: AGENT_ID,
      dataDir: DATA,
      senderId: f.phone,
      userText: userText || 'sent a photo',
      inboundNote,
    })
    broadcast({ type: 'typing', on: false })
    for (const bubble of result.bubbles.length ? result.bubbles : [result.reply]) {
      if (!bubble.trim()) continue
      broadcast({ type: 'bubble', from: 'alpha', text: bubble, source: result.source })
      await new Promise((r) => setTimeout(r, 350))
    }
    if (result.card) broadcast({ type: 'card', url: result.card.url })
  } catch (err) {
    broadcast({ type: 'typing', on: false })
    broadcast({ type: 'notice', text: `turn error: ${err instanceof Error ? err.message : String(err)}` })
  }
}

/* ---- HTTP: UI + control routes ---- */

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url)

  if (url.pathname === '/ws') {
    const { socket } = globalThis as unknown as { socket: unknown }
    void socket
    return new Response(null, { status: 426 })
  }

  if (url.pathname === '/api/send' && req.method === 'POST') {
    const { text } = (await req.json()) as { text?: string }
    if (text?.trim()) void handleInbound(text)
    return Response.json({ ok: true })
  }

  if (url.pathname === '/api/photo' && req.method === 'POST') {
    const form = await req.formData()
    const file = form.get('photo')
    if (file instanceof File) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      void handleInbound('', { bytes, mime: file.type || 'image/jpeg' })
    }
    return Response.json({ ok: true })
  }

  if (url.pathname === '/api/fixtures' && req.method === 'GET') {
    return Response.json(loadFixtures())
  }

  if (url.pathname === '/api/fixtures' && req.method === 'PUT') {
    const patch = (await req.json()) as Partial<Fixtures>
    saveFixtures({ ...loadFixtures(), ...patch })
    broadcast({ type: 'fixtures', fixtures: loadFixtures() })
    return Response.json(loadFixtures())
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    for (const name of ['events.json', 'threads']) {
      const p = join(DATA, name)
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* already gone */
      }
    }
    broadcast({ type: 'reset' })
    return Response.json({ ok: true })
  }

  if (url.pathname.startsWith('/card/')) {
    const kind = url.pathname.slice('/card/'.length) || 'home'
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,system-ui;background:#000;color:#eee;display:grid;place-items:center;height:100vh;margin:0}div{border:1px solid #333;border-radius:16px;padding:32px;text-align:center;max-width:320px}b{font-size:18px}p{color:#888;font-size:13px}</style></head><body><div><b>card: ${kind}</b><p>Locally minted stand-in. In prod this opens the real mini app at hirealpha.chat with a 7-day token. Card FLOW is what the testbed verifies.</p></div></body></html>`,
      { headers: { 'Content-Type': 'text/html' } },
    )
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return new Response(readFileSync(join(ROOT, 'ui.html'), 'utf8'), {
      headers: { 'Content-Type': 'text/html' },
    })
  }

  return new Response('not found', { status: 404 })
}

/** Bun WebSocket upgrade for the chat stream. */
type ServerWebSocket = { send: (d: string) => void; close: () => void; data?: unknown }
export const testbedWebsocket = {
  open: (ws: ServerWebSocket) => {
    clients.add(ws as unknown as WebSocket)
    ws.send(JSON.stringify({ type: 'hello', agent: AGENT_ID }))
  },
  message: () => {},
  close: (ws: ServerWebSocket) => clients.delete(ws as unknown as WebSocket),
}

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return undefined as unknown as Response
    return handler(req)
  },
  websocket: testbedWebsocket as never,
})

console.log(`[testbed] chat up:  http://localhost:${server.port}`)
console.log(`[testbed] agent=${AGENT_ID} data=${DATA}`)
console.log(`[testbed] fakes: profile/tools/nutrition/memory → fixtures.json; real: GMI + DuckDuckGo`)
console.log(`[testbed] needs GMI_API_KEY in .env for real model replies`)
void ({} as MiniAppKind)
