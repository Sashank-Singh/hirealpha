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

  it('rejects a stale rebuild past the ten-minute window', () => {
    expect(briefRowFresh(11 * 60_000, '2026-08-23', '2026-08-23')).toBe(false)
  })

  it('rejects a missing row', () => {
    expect(briefRowFresh(null, '2026-08-23', '2026-08-23')).toBe(false)
  })
})
