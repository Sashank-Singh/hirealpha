export type WatchIntervalResult =
  | { ok: true; hours: number }
  | { ok: false; error: string }

/** Parse a watch cadence without silently rounding, clamping, or replacing bad input. */
export function parseWatchInterval(value: unknown, defaultHours = 6): WatchIntervalResult {
  if (value === undefined || value === null) return { ok: true, hours: defaultHours }
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') {
    return { ok: false, error: 'intervalHours must be a whole number from 1 to 168' }
  }
  const hours = Number(value)
  if (!Number.isFinite(hours) || !Number.isInteger(hours) || hours < 1 || hours > 168) {
    return { ok: false, error: 'intervalHours must be a whole number from 1 to 168' }
  }
  return { ok: true, hours }
}
