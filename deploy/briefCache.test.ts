import { describe, expect, it } from 'bun:test'
import { briefRowFresh } from './hire-api'

describe('briefRowFresh', () => {
  it('serves a row built today and recently', () => {
    expect(briefRowFresh(60_000, '2026-08-23', '2026-08-23')).toBe(true)
    expect(briefRowFresh(9 * 60_000, '2026-08-23', '2026-08-23')).toBe(true)
  })

  it('rejects a row from another day', () => {
    expect(briefRowFresh(60_000, '2026-08-23', '2026-08-22')).toBe(false)
  })

  it('rejects a stale rebuild past the three-hour window', () => {
    expect(briefRowFresh(3 * 60 * 60_000 + 1, '2026-08-23', '2026-08-23')).toBe(false)
    // Under three hours is still fresh — the whole point of the widened window.
    expect(briefRowFresh(2 * 60 * 60_000 + 60_000, '2026-08-23', '2026-08-23')).toBe(true)
  })

  it('rejects a missing row', () => {
    expect(briefRowFresh(null, '2026-08-23', '2026-08-23')).toBe(false)
  })
})
