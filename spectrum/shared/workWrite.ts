/**
 * Write to a connected workspace (Notion page, Slack message) through the
 * server, which owns the provider call and the connection check. The bot never
 * posts anything itself: it asks, the route decides whether it can, and the
 * answer that comes back is the only thing either side may claim.
 */

export type WorkWriteInput = {
  title?: string
  body?: string
  channel?: string
  parent?: string
}

export type WorkWriteResult = { ok: boolean; message: string }

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

export async function writeToWorkspace(
  phone: string,
  persona: string,
  connector: string,
  input: WorkWriteInput,
): Promise<WorkWriteResult> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, message: 'The write route is not configured, so nothing was written.' }
  try {
    const res = await fetch(`${base}/api/internal/work/write`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone, persona, connector, ...input }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string }
    if (!res.ok) return { ok: false, message: data.message || `The write failed (${res.status}). Nothing was written.` }
    return { ok: data.ok === true, message: data.message || (data.ok ? 'Done.' : 'Nothing was written.') }
  } catch (err) {
    return {
      ok: false,
      message: `The write did not go through (${err instanceof Error ? err.message.slice(0, 80) : 'network'}). Nothing was written.`,
    }
  }
}
