/**
 * Whisper probe — times real speech-to-text on real clips.
 *
 * Two modes:
 *
 * 1. Production path (default): mints a session for HIREALPHA_PROBE_EMAIL,
 *    opens a throwaway meeting, and posts each clip to
 *    `/api/meetings/:id/transcribe` — the same route the meetings mini-app
 *    uses — then deletes the meeting. This is what "how fast is Alpha's
 *    transcription" actually means for a user.
 *
 * 2. Direct mode (`WHISPER_PROBE_URL=http://localhost:9000`): posts straight to
 *    a speaches / faster-whisper-server instance so models can be compared
 *    before one is pinned in production.
 *
 *   HIREALPHA_INTERNAL_KEY=... HIREALPHA_PROBE_EMAIL=you@example.com \
 *     bun run scripts/whisper-probe.ts /tmp/whisper-probe/voice1.m4a ...
 *
 *   WHISPER_PROBE_URL=http://localhost:9000 WHISPER_PROBE_MODEL=base.en \
 *     bun run scripts/whisper-probe.ts /tmp/whisper-probe/voice1.m4a
 */
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { basename } from 'node:path'

const PROD = (process.env.HIREALPHA_API_URL || 'https://hirealpha.chat').replace(/\/$/, '')
const DIRECT = (process.env.WHISPER_PROBE_URL || '').replace(/\/$/, '')
const KEY = process.env.HIREALPHA_INTERNAL_KEY || ''
const EMAIL = (process.env.HIREALPHA_PROBE_EMAIL || '').trim().toLowerCase()
const MODEL = process.env.WHISPER_PROBE_MODEL || process.env.STT_MODEL || 'small'

const files = process.argv.slice(2)
if (!files.length) throw new Error('usage: whisper-probe.ts <audio file> [...]')
if (!DIRECT && !KEY) throw new Error('HIREALPHA_INTERNAL_KEY is required')
if (!DIRECT && !EMAIL) throw new Error('HIREALPHA_PROBE_EMAIL is required')

/** Same shape hire-api mints: base64url({email,exp}) + '.' + hmac-sha256. */
function mintSession(email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + 60 * 60 * 1000 }),
  ).toString('base64url')
  const sig = createHmac('sha256', KEY).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function durationSeconds(file: string): number {
  try {
    const out = Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    return Number(out.stdout.toString().trim()) || 0
  } catch {
    return 0
  }
}

function report(file: string, bytes: number, ms: number, text: string) {
  const seconds = durationSeconds(file)
  const realtime = seconds > 0 ? `${(seconds / (ms / 1000)).toFixed(1)}x realtime` : ''
  console.log(
    `${basename(file)}  ${(bytes / 1024).toFixed(0)}KB  ${seconds.toFixed(1)}s audio  ${Math.round(ms)}ms  ${realtime}`,
  )
  console.log(`  "${text}"\n`)
}

/* ---- direct mode: hit the whisper server itself ---- */
if (DIRECT) {
  const base = DIRECT.endsWith('/v1') ? DIRECT : `${DIRECT}/v1`
  console.log(`direct: ${base}  model: ${MODEL}\n`)
  for (const file of files) {
    const bytes = readFileSync(file)
    const form = new FormData()
    form.append('file', new Blob([Uint8Array.from(bytes)], { type: 'audio/mp4' }), `voice.${file.split('.').pop()}`)
    form.append('model', MODEL)
    form.append('language', 'en')
    const started = performance.now()
    const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', body: form })
    const ms = performance.now() - started
    const body = (await res.json().catch(() => null)) as { text?: string } | null
    if (!res.ok || !body?.text) {
      console.log(`${basename(file)}  FAILED ${res.status} ${JSON.stringify(body)?.slice(0, 200)}\n`)
      continue
    }
    report(file, bytes.length, ms, body.text.trim())
  }
  process.exit(0)
}

/* ---- production mode: the whole hire-api path ---- */
const session = mintSession(EMAIL)

async function call(path: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${PROD}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const created = await call('/api/meetings', {
  method: 'POST',
  body: JSON.stringify({ session, title: 'whisper probe (temporary)' }),
})
if (created.status !== 200 || !created.body?.id) {
  throw new Error(`could not open a probe meeting: ${created.status} ${JSON.stringify(created.body)}`)
}
const meetingId: string = created.body.id
console.log(`probe meeting ${meetingId} on ${PROD}\n`)

try {
  for (const file of files) {
    const bytes = readFileSync(file)
    const started = performance.now()
    const res = await call(`/api/meetings/${meetingId}/transcribe`, {
      method: 'POST',
      body: JSON.stringify({ session, audioBase64: bytes.toString('base64'), mimeType: 'audio/mp4' }),
    })
    const ms = performance.now() - started
    if (res.status !== 200 || !res.body?.ok) {
      console.log(`${basename(file)}  FAILED ${res.status} ${JSON.stringify(res.body)}\n`)
      continue
    }
    report(file, bytes.length, ms, String(res.body.transcript || ''))
  }
} finally {
  const gone = await call(`/api/meetings/${meetingId}`, {
    method: 'DELETE',
    body: JSON.stringify({ session }),
  })
  console.log(`probe meeting deleted: ${gone.status === 200 ? 'ok' : JSON.stringify(gone.body)}`)
}
