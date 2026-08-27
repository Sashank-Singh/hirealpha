import { describe, expect, it } from 'bun:test'
import {
  buildApprovalText,
  buildHandoff,
  detectCancellationDeadline,
  findStaleThreads,
  formatProgressText,
  handoffIntent,
  needsApproval,
  pickMemoryResurface,
  postHandoff,
  shouldNudgeNearby,
} from './proactiveFlavors'

const NOW = Date.parse('2026-08-20T12:00:00Z')

describe('location nudge', () => {
  it('nudges when close and in the window', () => {
    expect(shouldNudgeNearby(800, 30, null, NOW)).toBe(true)
  })
  it('refuses when too far', () => {
    expect(shouldNudgeNearby(1600, 30, null, NOW)).toBe(false)
  })
  it('refuses outside the 15 to 45 minute window', () => {
    expect(shouldNudgeNearby(800, 10, null, NOW)).toBe(false)
    expect(shouldNudgeNearby(800, 50, null, NOW)).toBe(false)
  })
  it('respects the 3 hour cooldown', () => {
    const twoHoursAgo = NOW - 2 * 60 * 60 * 1000
    const fourHoursAgo = NOW - 4 * 60 * 60 * 1000
    expect(shouldNudgeNearby(800, 30, twoHoursAgo, NOW)).toBe(false)
    expect(shouldNudgeNearby(800, 30, fourHoursAgo, NOW)).toBe(true)
  })
})

describe('reservation cancel watch', () => {
  it('finds a deadline for reservable titles', () => {
    const start = Date.parse('2026-08-25T15:00:00Z')
    const out = detectCancellationDeadline('Hotel reservation, Plaza', new Date(start).toISOString())
    expect(out).not.toBeNull()
    expect(out!.warnBeforeHours).toBe(3)
    expect(out!.deadline).toBe(new Date(start - 24 * 60 * 60 * 1000).toISOString())
  })
  it('matches hotel, booking, and class wording', () => {
    expect(detectCancellationDeadline('Marriott hotel stay', '2026-08-25T15:00:00Z')).not.toBeNull()
    expect(detectCancellationDeadline('Spin class', '2026-08-25T15:00:00Z')).not.toBeNull()
    expect(detectCancellationDeadline('Booking at the Kimpton', '2026-08-25T15:00:00Z')).not.toBeNull()
  })
  it('ignores plain events and bad dates', () => {
    expect(detectCancellationDeadline('Lunch with Maya', '2026-08-25T15:00:00Z')).toBeNull()
    expect(detectCancellationDeadline('Hotel reservation', 'not a date')).toBeNull()
  })
})

describe('approval fence', () => {
  it('gates exactly the risky actions', () => {
    for (const a of ['send_email', 'purchase', 'booking', 'cancel', 'password_change']) {
      expect(needsApproval(a)).toBe(true)
    }
    expect(needsApproval('send_text')).toBe(false)
    expect(needsApproval('')).toBe(false)
  })
  it('builds an approval ask without dashes', () => {
    const text = buildApprovalText('send_email', 'to maya@example.com')
    expect(text).toContain('send that email')
    expect(text).toContain('Reply yes')
    expect(text).not.toMatch(/[-\u2013\u2014]/)
  })
})

describe('cross hire delegation', () => {
  it('detects the ask a peer intent', () => {
    expect(handoffIntent('ask my coworker to review the deck')).toBe('coworker')
    expect(handoffIntent('have my cofounder look at this')).toBe('cofounder')
    expect(handoffIntent('ask my friend for advice')).toBe('friend')
    expect(handoffIntent('ask the boss instead')).toBeNull()
  })
  it('builds the handoff payload', () => {
    const payload = buildHandoff('friend', 'coworker', 'review the deck')
    expect(payload.fromPersona).toBe('friend')
    expect(payload.toPersona).toBe('coworker')
    expect(payload.note).toBe('review the deck')
  })
  it('posts nothing without env', async () => {
    const saved = process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_API_URL
    expect(await postHandoff(buildHandoff('friend', 'coworker', 'x'))).toBe(false)
    if (saved) process.env.HIREALPHA_API_URL = saved
  })
})

describe('abandoned thread revival', () => {
  const now = Date.parse('2026-08-20T00:00:00Z')
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString()
  it('keeps threads awaiting a reply past 48h, oldest first, max 3', () => {
    const out = findStaleThreads(
      [
        { id: 'b', awaitingUserReply: true, lastActivityAt: hoursAgo(72) },
        { id: 'c', awaitingUserReply: false, lastActivityAt: hoursAgo(200) },
        { id: 'a', awaitingUserReply: true, lastActivityAt: hoursAgo(50) },
        { id: 'd', awaitingUserReply: true, lastActivityAt: hoursAgo(96) },
        { id: 'e', awaitingUserReply: true, lastActivityAt: hoursAgo(10) },
        { id: 'f', awaitingUserReply: true, lastActivityAt: hoursAgo(120) },
      ],
      now,
    )
    expect(out.map((t) => t.id)).toEqual(['f', 'd', 'b'])
  })
  it('honors a custom minimum age', () => {
    const out = findStaleThreads(
      [{ id: 'a', awaitingUserReply: true, lastActivityAt: hoursAgo(24) }],
      now,
      12,
    )
    expect(out.map((t) => t.id)).toEqual(['a'])
  })
  it('returns empty when all threads are fresh or answered', () => {
    expect(
      findStaleThreads(
        [
          { id: 'a', awaitingUserReply: true, lastActivityAt: hoursAgo(2) },
          { id: 'b', awaitingUserReply: false, lastActivityAt: hoursAgo(90) },
        ],
        now,
      ),
    ).toEqual([])
  })
})

describe('memory resurfacing', () => {
  it('picks the staledest memory past 21 days', () => {
    const now = Date.parse('2026-08-20T00:00:00Z')
    const out = pickMemoryResurface(
      [
        { key: 'city', value: 'Austin', lastSeen: now - 30 * 86_400_000 },
        { key: 'city', value: 'Lisbon', lastSeen: now - 40 * 86_400_000 },
        { key: 'city', value: 'Paris', lastSeen: now - 2 * 86_400_000 },
      ],
      now,
    )
    expect(out?.memory.value).toBe('Lisbon')
    expect(out?.question).toContain('Lisbon')
  })
  it('returns null when nothing is stale enough', () => {
    const now = Date.parse('2026-08-20T00:00:00Z')
    expect(
      pickMemoryResurface([{ key: 'city', value: 'Paris', lastSeen: now - 2 * 86_400_000 }], now),
    ).toBeNull()
    expect(pickMemoryResurface([], now)).toBeNull()
  })
  it('asks without dashes', () => {
    const now = Date.parse('2026-08-20T00:00:00Z')
    const out = pickMemoryResurface([{ key: 'sister', value: 'Maya in Denver', lastSeen: now - 40 * 86_400_000 }], now)
    expect(out!.question).not.toMatch(/[-\u2013\u2014]/)
  })
})

describe('progress narration', () => {
  it('formats one short line', () => {
    expect(formatProgressText('Deck', 40, 'share it with the team')).toBe(
      'Deck is 40% done, next up share it with the team',
    )
  })
  it('clamps and pads bad input', () => {
    expect(formatProgressText('Deck', 140, 'ship')).toBe('Deck is 100% done, next up ship')
    expect(formatProgressText('', NaN, '')).toBe('Task is 0% done, next up the next step')
  })
  it('never uses dashes', () => {
    expect(formatProgressText('Deck', 40, 'ship')).not.toMatch(/[-\u2013\u2014]/)
  })
})
