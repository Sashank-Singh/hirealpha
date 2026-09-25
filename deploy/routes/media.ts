import type { SQL } from 'bun'
import { isPersona, type Persona } from '../personas'
import { json } from '../utils/http'
import { getUserByPhone } from '../db/users'
import { loadMemories } from '../memory/store'
import { hotwordsFromMemories, transcribeAudio } from '../stt'
import { generateImage } from '../imageGen'

export async function handleMediaRoutes(
  req: Request,
  sql: SQL,
  options: { internalOk: (r: Request) => boolean },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  // Speech to text for the bots: an inbound iMessage voice note is transcribed
  // here rather than in each bot process, so the whisper endpoint and model are
  // configured in exactly one place (see transcribeAudio).
  if (path === '/api/internal/transcribe' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      audioBase64?: string
      mimeType?: string
      phone?: string
      persona?: string
    }
    const audio = body.audioBase64 ? Buffer.from(body.audioBase64, 'base64') : null
    if (!audio || audio.length < 256) return json({ error: 'audio is required' }, 400)
    // Bias the decoder with the words this user actually says: their name,
    // city, and the people they talk about. A 4-second "how's the weather in
    // SF?" came back as "in itself" until the city was in the prompt. Memory
    // is an optimization here — never a reason to fail the transcription.
    let hotwords = ''
    if (body.phone) {
      try {
        const user = await getUserByPhone(sql, body.phone)
        const persona: Persona = isPersona(body.persona || '') ? (body.persona as Persona) : 'friend'
        if (user) hotwords = hotwordsFromMemories(await loadMemories(sql, user.id, persona, 24))
      } catch (err) {
        console.warn('[stt] memory bias unavailable', err)
      }
    }
    const started = Date.now()
    try {
      const { text, model } = await transcribeAudio(body.mimeType || 'audio/mp4', audio, { hotwords })
      const ms = Date.now() - started
      console.log(`[stt] transcribed ${audio.length} bytes in ${ms}ms (${model}${hotwords ? ', biased' : ''})`)
      return json({ ok: true, text, ms })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[stt] transcribe failed after ${Date.now() - started}ms: ${msg}`)
      return json({ ok: false, error: msg.slice(0, 200) }, 502)
    }
  }

  /* Image generation for a picture ask. The bot's classifier decides that an
   * image is what was asked for (no pattern matching in the conversation path);
   * this route owns the provider, so a keyed provider replaces one function
   * call and the bot never learns which one ran. */
  if (path === '/api/internal/image' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      prompt?: string
      width?: number
      height?: number
      phone?: string
    }
    const prompt = String(body.prompt || '').trim()
    if (!prompt) return json({ error: 'prompt required' }, 400)
    if (prompt.length > 500) return json({ error: 'prompt too long' }, 400)
    const image = await generateImage(prompt, { width: body.width, height: body.height })
    if (!image) return json({ error: 'image generation unavailable' }, 502)
    console.log(`[image] generated for ${body.phone || 'unknown'} (${image.mimeType}, prompt ${image.prompt.length} chars)`)
    return json({ ok: true, dataUrl: image.dataUrl, mimeType: image.mimeType, model: image.model })
  }

  return null
}
