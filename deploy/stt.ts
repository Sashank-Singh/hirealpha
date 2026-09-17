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
 * the user their note did not come through. */
export async function transcribeAudio(
  mimeType: string,
  audioBytes: Uint8Array,
): Promise<{ text: string; model: string }> {
  const baseUrl = sttUrl()
  const primary = configuredSttModel()
  if (!degraded && primary !== STT_MODEL_FALLBACK) {
    try {
      return { text: await postTranscription(baseUrl, primary, mimeType, audioBytes), model: primary }
    } catch (err) {
      if (!(err instanceof SttModelError)) throw err
      degraded = true
      console.warn(`[stt] ${primary} cannot be loaded (${err.message}); using ${STT_MODEL_FALLBACK}`)
    }
  }
  return {
    text: await postTranscription(baseUrl, STT_MODEL_FALLBACK, mimeType, audioBytes),
    model: STT_MODEL_FALLBACK,
  }
}
