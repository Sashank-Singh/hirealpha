import { describe, expect, it } from 'bun:test'
import { briefRowFresh } from './hire-api'

describe('briefRowFresh', () => {
  it('serves a row built today within the last-minute window', () => {
    expect(briefRowFresh(1_000, '2026-08-23', '2026-08-23')).toBe(true)
    expect(briefRowFresh(59_000, '2026-08-23', '2026-08-23')).toBe(true)
  })

  it('rejects a row from another day', () => {
    expect(briefRowFresh(60_000, '2026-08-23', '2026-08-22')).toBe(false)
  })

  it('rebuilds past the one-minute window so mail stays fresh', () => {
    expect(briefRowFresh(61_000, '2026-08-23', '2026-08-23')).toBe(false)
    expect(briefRowFresh(10 * 60_000, '2026-08-23', '2026-08-23')).toBe(false)
  })

  it('rejects a missing row', () => {
    expect(briefRowFresh(null, '2026-08-23', '2026-08-23')).toBe(false)
  })
})
