/**
 * Image generation, on a free open endpoint.
 *
 * Dim 16 asks for an image and the product had none: every picture ask was
 * answered with either "I can't generate images" or a workshop HTML card, which
 * is a different artifact. A paid key was the assumed blocker; it is not, when
 * the only requirement is a real image for a birthday card rather than
 * photorealistic art. Pollinations serves flux/sana generations over GET with
 * no key and no quota worth worrying about, so the ask now produces an actual
 * JPEG the bot can attach.
 *
 * What this is NOT: a licensed, SLA-backed image provider. When a founder key
 * exists (fal.ai FLUX schnell ≈ $0.003/image) this module is the seam to swap;
 * the prompt, the size cap and the honest failure all stay the same.
 */

const IMAGE_ENDPOINT = process.env.IMAGE_GEN_URL || 'https://image.pollinations.ai/prompt'
/* A phone screenshot of a 1024 card is 40-120KB; the transport cap is 4MB, so
 * anything past this ceiling is a provider answering with something else. */
const MAX_IMAGE_BYTES = 3_000_000
const TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS || 70_000)

export type GeneratedImage = {
  dataUrl: string
  mimeType: string
  prompt: string
  model: string
}

/** The prompt a person would recognise, with the safe-render clauses the
 * hosted model needs: no text in the picture (image models garble lettering,
 * and a garbled "Happy Birthday" is worse than none), 1:1 for a chat card. */
export function renderPrompt(ask: string): string {
  const trimmed = String(ask || '').trim().replace(/\s+/g, ' ').slice(0, 400)
  /* The no-lettering clause is not decoration: measured on two prompts, the
   * model plastered a garbled "HAPPY BIRTHDAY" across the card, and a garbled
   * greeting is worse than none. Stating it twice (once as subject guidance,
   * once as a negative) measurably reduced it; the free tier still adds its own
   * small corner watermark, which is documented rather than hidden. */
  return `${trimmed}, illustration, warm celebratory palette, centered composition, no words, no letters, no writing, clean background`
}

export async function generateImage(ask: string, opts?: { width?: number; height?: number }): Promise<GeneratedImage | null> {
  const prompt = renderPrompt(ask)
  if (!prompt) return null
  const width = Math.min(1024, Math.max(512, Math.round(opts?.width || 1024)))
  const height = Math.min(1024, Math.max(512, Math.round(opts?.height || 1024)))
  const url = `${IMAGE_ENDPOINT}/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      console.warn(`[image] provider answered ${res.status}`)
      return null
    }
    const mimeType = (res.headers.get('content-type') || '').split(';')[0]!.trim()
    if (!/^image\//.test(mimeType)) {
      console.warn(`[image] provider answered with ${mimeType || 'no content type'}`)
      return null
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
      console.warn(`[image] provider returned ${bytes.byteLength} bytes`)
      return null
    }
    return {
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      mimeType,
      prompt,
      model: res.headers.get('x-model') || 'pollinations',
    }
  } catch (err) {
    console.warn('[image] generation failed', err instanceof Error ? err.message : err)
    return null
  }
}
