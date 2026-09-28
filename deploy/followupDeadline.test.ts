import { describe, expect, it } from 'bun:test'
import { nextFridayAt5 } from './followupDeadline'

describe('nextFridayAt5 — the deadline the follow-up offer names', () => {
  it('lands on a Friday at 17:00 local, strictly in the future', () => {
    // 2026-09-27 is a Sunday.
    const from = new Date('2026-09-27T12:00:00Z')
    const iso = nextFridayAt5(from, 'America/Los_Angeles')
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: false, weekday: 'short' }).format(new Date(iso))
    expect(local).toContain('Fri')
    expect(local).toContain('17:00')
  })

  it('skips to the NEXT Friday when today is Friday after 5pm', () => {
    // 2026-10-02 is a Friday; 23:00Z is 4 PM in LA — before 5. Use 01:00Z Sat
    // instead to test the strict-future walk.
    const from = new Date('2026-10-03T01:00:00Z') // Friday 18:00 in LA
    const iso = nextFridayAt5(from, 'America/Los_Angeles')
    expect(new Date(iso).getTime()).toBeGreaterThan(from.getTime())
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: false, weekday: 'short' }).format(new Date(iso))
    expect(local).toContain('Fri')
    expect(local).toContain('17:00')
  })
})
