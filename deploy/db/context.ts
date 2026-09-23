import type { SQL } from 'bun'
import type { Persona } from '../personas'

export async function loadContext(
  sql: SQL,
  userId: string,
  persona: Persona,
): Promise<Record<string, string>> {
  const rows = await sql`
    SELECT fields FROM hire_context WHERE user_id = ${userId} AND persona = ${persona} LIMIT 1
  `
  const fields = rows[0]?.fields
  if (!fields) return {} as Record<string, string>
  let value: unknown = fields
  // Legacy rows may hold a JSON string scalar (from an earlier stringify-on-
  // write bug). Parse at most a couple of layers, then require an object.
  for (let i = 0; i < 3 && typeof value === 'string'; i++) {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  // A compounding-stringify row can still carry megabytes of nested junk.
  // Keep only sane scalar values; anything oversized is corruption.
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      if (v.length <= 4_000) out[k] = v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v)
    } else if (v && typeof v === 'object') {
      const encoded = JSON.stringify(v)
      if (encoded.length <= 4_000) out[k] = encoded
    }
  }
  return out
}

export async function upsertContext(
  sql: SQL,
  userId: string,
  persona: Persona,
  patch: Record<string, unknown>,
): Promise<Record<string, string>> {
  const fields = await loadContext(sql, userId, persona)
  const next = { ...fields, ...patch }
  // Pass the object, never JSON.stringify: a stringified value lands in the
  // JSONB column as a JSON *string scalar*, and every later upsert then wraps
  // the previous payload in another escaping layer — a compounding loop that
  // grew one row past 5 MB and stalled every /live read.
  await sql`
    INSERT INTO hire_context (user_id, persona, fields, updated_at)
    VALUES (${userId}, ${persona}, ${next}, now())
    ON CONFLICT (user_id, persona)
    DO UPDATE SET fields = ${next}, updated_at = now()
  `
  return next as Record<string, string>
}

/** Normalize the stored `setup` field (array, JSON string, or absent) into string[]. */
export function parseSetupField(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}
