import { describe, expect, it } from 'bun:test'
import { isClock, sleepHoursBetween } from './habits/parsers'

/**
 * Pure unit tests for sleep ingest payload parsing.
 */

function parseSleepIngestPayload(body: {
  bedtime?: unknown
  wake?: unknown
  sleepDate?: unknown
  source?: unknown
}): { bedtime: string; wake: string; sleepDate: string | null; source: string } | { error: string } {
  const bedtime = String(body.bedtime || '').trim()
  const wake = String(body.wake || '').trim()
  if (!isClock(bedtime) || !isClock(wake)) {
    return { error: 'bedtime and wake required as HH:MM' }
  }
  const rawDate = String(body.sleepDate || '').trim()
  const sleepDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null
  const source = String(body.source || 'apple_health').slice(0, 40)
  return { bedtime, wake, sleepDate, source }
}

describe('sleep ingest payload parsing', () => {
  describe('isClock', () => {
    it('accepts valid HH:MM', () => {
      expect(isClock('23:00')).toBe(true)
      expect(isClock('07:00')).toBe(true)
      expect(isClock('00:00')).toBe(true)
      expect(isClock('9:30')).toBe(true)
    })

    it('rejects invalid formats', () => {
      expect(isClock('')).toBe(false)
      expect(isClock('25:00')).toBe(false)
      expect(isClock('23:60')).toBe(false)
      expect(isClock('11pm')).toBe(false)
      expect(isClock('23')).toBe(false)
    })
  })

  describe('sleepHoursBetween', () => {
    it('computes 8h for 11pm to 7am', () => {
      expect(sleepHoursBetween('23:00', '07:00')).toBe(8)
    })

    it('computes 7.5h for midnight crossing', () => {
      expect(sleepHoursBetween('23:30', '07:00')).toBe(7.5)
    })

    it('computes hours when bedtime is before midnight', () => {
      expect(sleepHoursBetween('22:00', '06:00')).toBe(8)
    })

    it('handles same-day window (early riser)', () => {
      expect(sleepHoursBetween('01:00', '08:00')).toBe(7)
    })

    it('returns 0 for non-numeric input', () => {
      expect(sleepHoursBetween('bad', 'time')).toBe(0)
    })

    it('rounds to one decimal place', () => {
      expect(sleepHoursBetween('23:00', '06:22')).toBe(7.4)
    })
  })

  describe('parseSleepIngestPayload', () => {
    it('accepts a valid Apple Health payload', () => {
      const result = parseSleepIngestPayload({
        bedtime: '23:00',
        wake: '07:00',
        sleepDate: '2026-08-17',
        source: 'apple_health',
      })
      expect(result).toEqual({ bedtime: '23:00', wake: '07:00', sleepDate: '2026-08-17', source: 'apple_health' })
    })

    it('defaults source to apple_health when omitted', () => {
      const result = parseSleepIngestPayload({ bedtime: '23:00', wake: '07:00' })
      expect('source' in result && (result as { source: string }).source).toBe('apple_health')
    })

    it('returns null sleepDate when omitted (server will compute yesterday)', () => {
      const result = parseSleepIngestPayload({ bedtime: '23:00', wake: '07:00' })
      expect('sleepDate' in result && (result as { sleepDate: string | null }).sleepDate).toBeNull()
    })

    it('rejects missing bedtime', () => {
      const result = parseSleepIngestPayload({ wake: '07:00' })
      expect('error' in result).toBe(true)
    })

    it('rejects missing wake', () => {
      const result = parseSleepIngestPayload({ bedtime: '23:00' })
      expect('error' in result).toBe(true)
    })

    it('rejects 12-hour format without AM/PM', () => {
      const result = parseSleepIngestPayload({ bedtime: '11:00pm', wake: '7:00am' })
      expect('error' in result).toBe(true)
    })

    it('accepts single-digit hour', () => {
      const result = parseSleepIngestPayload({ bedtime: '9:30', wake: '6:00' })
      expect('error' in result).toBe(false)
    })

    it('computes correct hours for typical night', () => {
      const result = parseSleepIngestPayload({ bedtime: '23:00', wake: '07:00' })
      if ('error' in result) throw new Error(result.error)
      expect(sleepHoursBetween(result.bedtime, result.wake)).toBe(8)
    })
  })
})
