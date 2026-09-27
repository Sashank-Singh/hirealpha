import { describe, expect, it } from 'bun:test'
import { parseWatchInterval } from './watchInterval'

describe('parseWatchInterval', () => {
  it.each([1, '1', 6, '6', 24, '24', 168, '168'])('accepts %p exactly', (input) => {
    expect(parseWatchInterval(input)).toEqual({ ok: true, hours: Number(input) })
  })

  it.each([0, '0', -1, '-1', 1.5, '1.5', Number.NaN, 'NaN', 169, '169', '', true])('rejects %p', (input) => {
    expect(parseWatchInterval(input).ok).toBe(false)
  })

  it('uses the documented default only when the field is absent', () => {
    expect(parseWatchInterval(undefined)).toEqual({ ok: true, hours: 6 })
    expect(parseWatchInterval(null)).toEqual({ ok: true, hours: 6 })
  })
})
