import { describe, expect, test } from 'bun:test'
import {
  assessmentCandidates, assessOffline, assessmentHedge, evidencePlanNote,
  inferAssessmentDomains, minimumEvidenceCheck, replyAdmitsGap,
} from './assessment'
import { ClaimLedger, enforceClaimEvidence, claimViolationCount } from './claimEvidence'

/** Assessment routing: the four routing misses from the last battery, plus the
 * readiness/collision classes, must all resolve to an evidence plan. */
describe('assessment routing — candidate gate', () => {
  test('state-evaluation asks are candidates', () => {
    const asks = [
      'Can I afford a $400 trip to Austin next weekend?',
      'What am I forgetting before I leave for Denver Thursday?',
      'Where did my week go?',
      'Am I on track this week?',
      'Should I be worried about anything before Friday?',
      'Is anything going to collide next week?',
      'Am I ready for my interview tomorrow?',
      'Am I ready for launch Friday?',
      'Do I owe anyone anything?',
      'What am I waiting on?',
      'Did I miss anything?',
      'Anything I need to handle before tomorrow?',
      'What needs my attention today?',
      'How much room do I have this week?',
      'Is my schedule realistic tomorrow?',
      'What should I focus on?',
      'What changed since yesterday?',
      'What do I still need to do?',
    ]
    for (const ask of asks) expect(assessmentCandidates(ask)).toBe(true)
  })

  test('action asks and casual chat are NOT candidates', () => {
    for (const ask of [
      'book the zephyr for oct 1',
      'send it',
      'remind me at 6pm to call the vet',
      'log my lunch: chicken bowl',
      'Thanks!',
      'haha nice',
      'what is the capital of australia?',
    ]) expect(assessmentCandidates(ask)).toBe(false)
  })

  test('the four known routing misses resolve to real domain plans', () => {
    expect(inferAssessmentDomains('Can I afford a $400 trip to Austin next weekend?')).toContain('money')
    const forgetting = inferAssessmentDomains('What am I forgetting before I leave for Denver Thursday?')
    expect(forgetting).toContain('mail')
    expect(forgetting).toContain('commitments')
    expect(inferAssessmentDomains('How busy is my week looking?')).toContain('calendar')
    const week = inferAssessmentDomains('Where did my week go?')
    expect(week).toContain('calendar')
    expect(week).toContain('plans')
    expect(inferAssessmentDomains('Am I on track this week?')).toContain('plans')
    expect(inferAssessmentDomains('Do I need to follow up with anyone from yesterday?')).toContain('mail')
  })

  test('domain inference generalizes — no phrase table', () => {
    // Same domain, different phrasings, none in any list above.
    expect(inferAssessmentDomains('do I have enough set aside for this?')).toContain('money')
    expect(inferAssessmentDomains('is my afternoon workable?')).toContain('calendar')
    expect(inferAssessmentDomains('who is still waiting on me?')).toContain('mail')
    expect(inferAssessmentDomains('how far along is the launch prep?')).toContain('plans')
  })
})

describe('assessment routing — evidence plan', () => {
  test('the note names the minimum sources and the cost discipline', () => {
    const plan = assessOffline('Can I afford a $180 hotel?')
    const note = evidencePlanNote(plan, {
      available: ['gmail', 'calendar', 'drive'],
      constraints: [{ value: 'Never spend more than $500 without asking first.', capDollars: 500 }],
    })
    expect(note).toMatch(/ASSESSMENT TURN/)
    expect(note).toMatch(/spending_overview/)
    expect(note).toMatch(/\$500/)
    expect(note).toMatch(/Do NOT call drive, web, or maps/)
    expect(note).toMatch(/based on what you'?ve logged|logged or approved/i)
  })

  test('a non-assessment turn gets no note', () => {
    expect(evidencePlanNote(assessOffline('book it'), { available: ['gmail'] })).toBeNull()
  })

  test('plan state is carried into the note when a plan exists', () => {
    const plan = assessOffline('Am I on track?')
    const note = evidencePlanNote(plan, { available: ['calendar'], planBlock: 'Goal: launch | 1. [done] spec | 2. [pending] ship' })
    expect(note).toMatch(/Plan state/)
    expect(note).toMatch(/\[pending\] ship/)
  })
})

describe('assessment routing — minimum evidence', () => {
  test('money without spend evidence is not ok; with it, ok', () => {
    const plan = assessOffline('Can I afford this trip?')
    expect(minimumEvidenceCheck(plan, ['calendar']).ok).toBe(false)
    expect(minimumEvidenceCheck(plan, ['money']).ok).toBe(true)
  })

  test('a readiness ask with calendar read but no mail is allowed, with mail named missing', () => {
    const plan = assessOffline('Am I ready for my interview tomorrow?')
    const check = minimumEvidenceCheck(plan, ['calendar'])
    expect(check.ok).toBe(true)
    expect(check.missing).toContain('mail')
  })

  test('the hedge names exactly the unchecked sources and is skipped when already admitted', () => {
    const plan = assessOffline('Am I ready for my interview tomorrow?')
    const hedge = assessmentHedge(plan, ['mail', 'commitments'])
    expect(hedge).toMatch(/What I have not checked: your inbox, commitments/)
    expect(replyAdmitsGap('Your calendar is clear. I haven\'t checked email yet.')).toBe(true)
    expect(replyAdmitsGap('You are all set.')).toBe(false)
  })
})

describe('assessment routing — affordable claims stay evidence-backed', () => {
  test('"you can afford it" without spend evidence is rewritten to the logged-spend hedge', () => {
    const before = claimViolationCount()
    const l = new ClaimLedger()
    l.record('calendar_read', 'verified_success', {})
    const out = enforceClaimEvidence('You can afford it easily.', l)
    expect(out.violations.length).toBe(1)
    expect(out.reply).toMatch(/Based on what you have logged/)
    expect(claimViolationCount()).toBe(before + 1)
  })

  test('with spend evidence the claim passes', () => {
    const l = new ClaimLedger()
    l.record('spend', 'verified_success', {})
    expect(enforceClaimEvidence('You can afford it easily.', l).violations).toEqual([])
  })
})
