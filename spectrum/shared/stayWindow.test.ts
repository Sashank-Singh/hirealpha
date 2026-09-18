import { describe, expect, it } from 'bun:test'
import { stayWindowFromAsk } from './stayWindow'

/** A Friday, so "next Friday" is unambiguous in these fixtures. */
const FRIDAY = new Date('2026-09-18T15:00:00Z')

describe('stayWindowFromAsk', () => {
  /* Live: "hotel in Chicago for Friday and Saturday next week" was read as one
   * night, so every rate the user saw was for the wrong stay. */
  it('honours "next week"', () => {
    // Asked on a Friday, "Friday and Saturday next week" is the following
    // weekend, not tonight: same arithmetic, different week.
    expect(stayWindowFromAsk('hotel in Chicago for Friday and Saturday next week', FRIDAY)).toEqual({
      checkIn: '2026-09-25',
      checkOut: '2026-09-27',
      nights: 2,
    })
    expect(stayWindowFromAsk('hotel Tuesday to Thursday next week', FRIDAY)).toEqual({
      checkIn: '2026-09-22',
      checkOut: '2026-09-24',
      nights: 2,
    })
  })

  it('reads two named nights as two nights', () => {
    expect(stayWindowFromAsk('Book me a hotel in Chicago for Friday and Saturday, under 250 a night', FRIDAY)).toEqual({
      checkIn: '2026-09-18',
      checkOut: '2026-09-20',
      nights: 2,
    })
  })

  it('reads a weekday span', () => {
    expect(stayWindowFromAsk('hotel Friday to Sunday', FRIDAY)?.nights).toBe(2)
    expect(stayWindowFromAsk('hotel in Chicago Monday through Wednesday', FRIDAY)?.nights).toBe(2)
  })

  it('does not read a nightly rate as a stay length', () => {
    // "under 250 a night" is a price.
    // No window described at all: the caller's own date handling decides.
    expect(stayWindowFromAsk('hotel in Chicago under 250 a night', FRIDAY)).toBeNull()
    expect(stayWindowFromAsk('3 nights in Chicago', FRIDAY)?.nights).toBe(3)
  })

  it('reads counted nights and the weekend shorthand', () => {
    expect(stayWindowFromAsk('hotel for 3 nights starting Tuesday', FRIDAY)).toEqual({ checkIn: '2026-09-22', checkOut: '2026-09-25', nights: 3 })
    expect(stayWindowFromAsk('a weekend hotel in the Loop', FRIDAY)?.nights).toBe(2)
    expect(stayWindowFromAsk('two nights in Chicago', FRIDAY)?.nights).toBe(2)
  })

  it('stays out of the way when the ask names real dates or no window', () => {
    expect(stayWindowFromAsk('hotel Sep 25 to Sep 27', FRIDAY)).toBeNull()
    expect(stayWindowFromAsk('hotel from 2026-09-25 to 2026-09-27', FRIDAY)).toBeNull()
    expect(stayWindowFromAsk('find me a good coffee shop', FRIDAY)).toBeNull()
  })
})
