/**
 * Speech to text: the one place that talks to the self-hosted whisper service
 * (speaches / faster-whisper-server, OpenAI-compatible) behind STT_URL.
 *
 * Voice notes are the latency-critical caller — a user is staring at the thread
 * while their clip is decoded — so the model is configurable (STT_MODEL) and
 * every request asks for English explicitly, which skips the model's language
 * detection pass. If the configured model cannot be loaded, the next request
 * falls back to the one the service was provisioned with instead of leaving the
 * user with nothing.
 */

const STT_URL_DEFAULT = 'http://whisper-hkwfzdglv38jeqhzxys4xkvd:8000/v1'
const STT_MODEL_DEFAULT = 'small'
const STT_MODEL_FALLBACK = 'Systran/faster-whisper-small'

/** Whisper decodes by content, so the filename only has to look like audio. */
const STT_EXT_BY_SUBTYPE: Record<string, string> = {
  mpeg: 'mp3',
  mp3: 'mp3',
  'x-m4a': 'm4a',
  m4a: 'm4a',
  mp4: 'm4a',
  aac: 'm4a',
  caf: 'caf',
  'x-caf': 'caf',
  wav: 'wav',
  'x-wav': 'wav',
  webm: 'webm',
  ogg: 'ogg',
  aiff: 'aiff',
  'x-aiff': 'aiff',
}

let degraded = false

/** A model the service cannot load at all (unknown repo, not a CTranslate2
 * conversion). Only this justifies the fallback — a service error or a clip
 * with no speech in it must not silently switch models. */
export class SttModelError extends Error {}

/** Memory keys whose values name the people, places, and things a voice note is
 * most likely to mention, most valuable first: the decoder gets the user's own
 * name and city before it spends the budget on project names. */
const BIAS_KEYS: string[] = [
  'preferred_name',
  'name',
  'city',
  'home_city',
  'work_city',
  'location',
  'neighborhood',
  'people',
  'partner',
  'sister',
  'team',
  'company',
  'company_name',
  'school',
  'projects',
  'hotel_city',
]

/** Trim to `max` without ending on half a word. */
function trimWord(value: string, max: number): string {
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > 20 ? cut.slice(0, space) : cut).trim()
}

/**
 * Proper nouns to bias the decoder with. Whisper hears what it expects: the
 * 4-second "how's the weather in SF?" came back as "how's the weather in
 * itself" until the user's own city was in the prompt. Deliberately short —
 * a long prompt makes the model hear words nobody said — and never fatal:
 * without memories the transcription just runs unbiased.
 */
export function hotwordsFromMemories(memories: Array<{ key?: string; value?: string }>, cap = 240): string {
  const byKey = new Map<string, string[]>()
  for (const memory of memories) {
    const key = String(memory.key || '').trim().toLowerCase()
    if (!BIAS_KEYS.includes(key)) continue
    const clean = trimWord(
      String(memory.value || '')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^\p{L}\p{N}\s'&.-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      60,
    )
    if (!clean) continue
    const values = byKey.get(key) || []
    values.push(clean)
    byKey.set(key, values)
  }
  const words: string[] = []
  const seen = new Set<string>()
  for (const key of BIAS_KEYS) {
    for (const value of byKey.get(key) || []) {
      const normalized = value.toLowerCase()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      words.push(value)
    }
  }
  let bias = ''
  for (const word of words) {
    const next = bias ? `${bias}. ${word}` : word
    if (next.length > cap) break
    bias = next
  }
  return bias
}

/** Test seam: forget that the configured model failed. */
export function resetSttModelDegraded(): void {
  degraded = false
}

export function sttUrl(): string {
  return (process.env.STT_URL || STT_URL_DEFAULT).replace(/\/$/, '')
}

export function configuredSttModel(): string {
  return process.env.STT_MODEL || STT_MODEL_DEFAULT
}

async function postTranscription(
  baseUrl: string,
  model: string,
  mimeType: string,
  audioBytes: Uint8Array,
  hotwords = '',
): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 120_000)
  try {
    const form = new FormData()
    const subtype = (mimeType.split('/')[1] || '').split(';')[0].trim().toLowerCase()
    const ext = STT_EXT_BY_SUBTYPE[subtype] || 'm4a'
    form.append('file', new Blob([Uint8Array.from(audioBytes)], { type: mimeType }), `voice.${ext}`)
    form.append('model', model)
    // An English-only model rejects the hint; a multilingual one uses it.
    const language = process.env.STT_LANGUAGE ?? 'en'
    if (language && !/\.en$/i.test(model)) form.append('language', language)
    if (hotwords) form.append('hotwords', hotwords)
    // Voice notes are recorded around speech, not on top of it: the VAD pass
    // drops the silence that whisper likes to hallucinate words into.
    form.append('vad_filter', 'true')
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const detail = `Whisper ${res.status}: ${body.slice(0, 160)}`
      if (res.status === 404 || /not found|registry|no such model|unsupported model/i.test(body)) {
        throw new SttModelError(detail)
      }
      throw new Error(detail)
    }
    const data = (await res.json()) as { text?: string }
    const text = String(data.text || '').trim()
    if (!text) throw new Error('Whisper returned empty transcript')
    return text
  } finally {
    clearTimeout(t)
  }
}

/** Transcribe one clip. Throws when the service refuses, so callers can tell
 * the user their note did not come through. `hotwords` carries the user's own
 * names and places; see {@link hotwordsFromMemories}. */
export async function transcribeAudio(
  mimeType: string,
  audioBytes: Uint8Array,
  options: { hotwords?: string } = {},
): Promise<{ text: string; model: string }> {
  const baseUrl = sttUrl()
  const primary = configuredSttModel()
  const hotwords = options.hotwords || ''
  if (!degraded && primary !== STT_MODEL_FALLBACK) {
    try {
      return { text: await postTranscription(baseUrl, primary, mimeType, audioBytes, hotwords), model: primary }
    } catch (err) {
      if (!(err instanceof SttModelError)) throw err
      degraded = true
      console.warn(`[stt] ${primary} cannot be loaded (${err.message}); using ${STT_MODEL_FALLBACK}`)
    }
  }
  return {
    text: await postTranscription(baseUrl, STT_MODEL_FALLBACK, mimeType, audioBytes, hotwords),
    model: STT_MODEL_FALLBACK,
  }
}
