import { describe, expect, it } from 'bun:test'
import {
  handleBillguard,
  handleBrainDump,
  handleDebrief,
  handleKeepMeHonest,
  handleRecall,
  handleSnapLog,
  handleSweep,
  handleToolbox,
  handleTravelMode,
  looksLikeBillguard,
  looksLikeBrainDump,
  looksLikeDebrief,
  looksLikeKeepMeHonest,
  looksLikeRecall,
  looksLikeSnapLog,
  looksLikeSweep,
  looksLikeToolbox,
  looksLikeTravelMode,
} from './smartFeatures'

describe('smart features — recall', () => {
  it('recalls a keyword across loops and decisions', () => {
    const out = handleRecall('recall what I promised maya', {
      loops: ['I owe Maya the deck'],
      decisions: ['Hired Sarah'],
      meetings: ['Met Maya at the meetup'],
    })
    expect(out).toContain('Maya')
    expect(out).toContain('deck')
  })
  it('detects recall phrasing', () => {
    expect(looksLikeRecall('what did I promise maya')).toBe(true)
    expect(looksLikeRecall('did we decide on the vendor')).toBe(true)
  })
})

describe('smart features — debrief', () => {
  it('opens a debrief with the meeting who', () => {
    const out = handleDebrief('11:30 AM · Maria (Software Engineer)')
    expect(out).toContain('Maria')
    expect(out).toContain('promise')
  })
  it('detects debrief phrasing', () => {
    expect(looksLikeDebrief('debrief the call')).toBe(true)
    expect(looksLikeDebrief('how did the meeting go')).toBe(true)
  })
})

describe('smart features — sweep', () => {
  it('counts pending drafts', () => {
    const out = handleSweep(3, ['a', 'b', 'c'])
    expect(out).toContain('3 waiting on you')
    expect(out).toContain('1. a')
  })
  it('says inbox zero', () => {
    expect(handleSweep(0, [])).toContain('Inbox zero')
  })
})

describe('smart features — brain dump', () => {
  it('splits a dump into loops, decisions, and notes', () => {
    const out = handleBrainDump('dump: call the dentist. We decided on Stripe. Bought milk', 'US/Pacific')
    expect(out).toContain('Loops:')
    expect(out).toContain('call the dentist')
    expect(out).toContain('Decisions:')
    expect(out).toContain('Stripe')
    expect(out).toContain('Bought milk')
  })
  it('detects dump phrasing', () => {
    expect(looksLikeBrainDump('dump: todo…')).toBe(true)
    expect(looksLikeBrainDump('brain dump: …')).toBe(true)
  })
})

describe('smart features — snap log', () => {
  it('asks for the photo', () => {
    expect(handleSnapLog()).toContain('photo')
  })
  it('detects snap phrasing', () => {
    expect(looksLikeSnapLog('snap log this meal')).toBe(true)
  })
})

describe('smart features — billguard', () => {
  it('lists subscriptions', () => {
    const logs = [
      { amount: 1800, category: 'housing', description: 'rent', spentAt: '2026-08-01' },
      { amount: 15.49, category: 'other', description: 'Netflix' },
    ]
    const out = handleBillguard('netflix', logs, 2100, 2500)
    expect(out).toContain('Netflix')
    expect(out).toContain('$15.49')
    const housing = handleBillguard('housing', logs, 2100, 2500)
    expect(housing).toContain('$1800')
    expect(housing).toContain('rent')
  })
  it('detects billguard phrasing', () => {
    expect(looksLikeBillguard('how much do i pay for netflix')).toBe(true)
    expect(looksLikeBillguard('my subscriptions?')).toBe(true)
  })
})

describe('smart features — travel mode', () => {
  it('acknowledges the trip', () => {
    expect(handleTravelMode('tokyo')).toContain('Travel mode on for tokyo')
  })
  it('detects travel phrasing', () => {
    expect(looksLikeTravelMode('travel mode to tokyo')).toBe(true)
    expect(looksLikeTravelMode('flying to paris next week')).toBe(true)
  })
})

describe('smart features — keep me honest', () => {
  it('parses time and what', () => {
    const out = handleKeepMeHonest('keep me honest at 7pm to run', 'US/Pacific')
    expect(out).toContain('run')
    expect(out).toContain('19:00')
  })
  it('detects the phrase', () => {
    expect(looksLikeKeepMeHonest('keep me honest at 7pm to run')).toBe(true)
    expect(looksLikeKeepMeHonest('text me if I have not logged a run')).toBe(true)
  })
})

describe('smart features — toolbox', () => {
  it('lists kept builds', () => {
    const out = handleToolbox([{ title: 'Pomodoro', url: 'https://x/b/1' }])
    expect(out).toContain('Pomodoro')
    expect(out).toContain('https://x/b/1')
  })
  it('detects toolbox phrasing', () => {
    expect(looksLikeToolbox('show me my tools')).toBe(true)
    expect(looksLikeToolbox('my builds?')).toBe(true)
  })
})