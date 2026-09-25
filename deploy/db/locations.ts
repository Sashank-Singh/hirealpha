import type { SQL } from 'bun'

export type LocationRow = {
  user_id: string
  kind: 'current' | 'home' | 'work'
  latitude: number
  longitude: number
  accuracy_m: number | null
  label: string
  source: string | null
  updated_at: Date
}

export async function loadLocations(sql: SQL, userId: string): Promise<LocationRow[]> {
  const rows = await sql`
    SELECT user_id, kind, latitude, longitude, accuracy_m, label, source, updated_at
    FROM hire_user_locations
    WHERE user_id = ${userId}
    ORDER BY updated_at DESC
  `
  return rows as LocationRow[]
}

export async function getLocation(sql: SQL, userId: string, kind: 'current' | 'home' | 'work') {
  const rows = await sql`
    SELECT user_id, kind, latitude, longitude, accuracy_m, label, source, updated_at
    FROM hire_user_locations
    WHERE user_id = ${userId} AND kind = ${kind}
    LIMIT 1
  `
  return (rows[0] as LocationRow | undefined) ?? null
}

export const CURRENT_LOCATION_HOURS = 24

/** Server-side: pick the active location to bias map/data queries with. */
export async function pickActiveLocation(sql: SQL, userId: string): Promise<LocationRow | null> {
  const locs = await loadLocations(sql, userId)
  if (!locs.length) return null
  const current = locs.find((l) => l.kind === 'current')
  if (
    current &&
    Date.now() - new Date(current.updated_at).getTime() < CURRENT_LOCATION_HOURS * 60 * 60 * 1000
  ) {
    return current
  }
  return locs.find((l) => l.kind === 'home') || locs.find((l) => l.kind === 'work') || null
}

/** Safe label the bot may see; never contains raw coordinates. */
export function locationLabel(loc: LocationRow): string {
  if (loc.kind === 'current') return 'current location'
  if (loc.kind === 'home') return 'Home'
  if (loc.kind === 'work') return 'Work'
  return loc.label || 'known location'
}

export function coordsUsable(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  )
}
