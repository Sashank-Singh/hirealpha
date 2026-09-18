/**
 * Ask the server for a generated image. The bot never talks to an image
 * provider directly: the route owns the provider (and will own the paid one
 * when a key exists), so swapping it is a server change and the bot keeps
 * sending bytes exactly the way it already sends browser screenshots.
 */

export type TurnImage = {
  dataUrl: string
  mimeType: string
  caption?: string
}

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

export async function generateTurnImage(
  phone: string,
  prompt: string,
): Promise<TurnImage | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || !prompt.trim()) return null
  try {
    const res = await fetch(`${base}/api/internal/image`, {
      method: 'POST',
      // Rendering a picture is slower than any other call the turn makes; the
      // provider measures 5-40s on a cold prompt.
      signal: AbortSignal.timeout(75_000),
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone, prompt: prompt.trim().slice(0, 500) }),
    })
    if (!res.ok) {
      console.warn(`[image] route answered ${res.status}`)
      return null
    }
    const data = (await res.json()) as { dataUrl?: string; mimeType?: string }
    if (!data.dataUrl || !/^data:image\//.test(data.dataUrl)) return null
    return { dataUrl: data.dataUrl, mimeType: data.mimeType || 'image/jpeg' }
  } catch (err) {
    console.warn('[image] request failed', err instanceof Error ? err.message : err)
    return null
  }
}
