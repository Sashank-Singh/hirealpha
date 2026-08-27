import { describe, expect, it } from 'bun:test'
import {
  handleBillguard,
  handleBrainDump,
  handleChatImport,
  handleDebrief,
  handleKeepMeHonest,
  handleRecall,
  handleSnapLog,
  handleSweep,
  handleToolbox,
  handleTravelMode,
  keepHonestPlan,
  keepTravelPlan,
  looksLikeBillguard,
  looksLikeBrainDump,
  looksLikeChatImport,
  looksLikeDebrief,
  looksLikeKeepMeHonest,
  looksLikeRecall,
  looksLikeSnapLog,
  looksLikeSweep,
  looksLikeToolbox,
  looksLikeTravelMode,
  parseBrainDump,
  parseChatExport,
  parseMeetingAnswer,
  parseSweepApproval,
  scanSubscriptions,
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
describe('smart features — brain dump (structured parse)', () => {
  it('splits a dump into loops, decisions, and notes', () => {
    const items = parseBrainDump('dump: call the dentist. We decided on Stripe. Bought milk')
    expect(items.loops.some((l) => l.startsWith('call the dentist'))).toBe(true)
    expect(items.decisions.some((d) => d.includes('Stripe'))).toBe(true)
    expect(items.notes).toContain('Bought milk')
  })
})

describe('smart features — keep me honest (structured parse)', () => {
  it('extracts what and a 24h clock time', () => {
    expect(keepHonestPlan('keep me honest at 7pm to run')).toEqual({ what: 'to run', hour: 19, minute: 0 })
    expect(keepHonestPlan('keep me honest at 7:30am to meditate')).toEqual({ what: 'to meditate', hour: 7, minute: 30 })
  })
  it('returns null without a time or a what', () => {
    expect(keepHonestPlan('keep me honest')).toBeNull()
  })
})

describe('smart features — chat import (B3)', () => {
  it('parses iMessage bracket lines into per-person context, dropping the user', () => {
    const people = parseChatExport('[2026-08-01 14:03] Maya: the deck looks great\n[2026-08-01 14:04] You: thanks\n[2026-08-01 14:05] Maya: send by friday?')
    expect(people.length).toBe(1)
    expect(people[0].name).toContain('Maya')
    expect(people[0].lines).toHaveLength(2)
  })
  it('detects import intent', () => {
    expect(looksLikeChatImport('import this whatsapp chat')).toBe(true)
    expect(looksLikeChatImport('sync my iMessage thread with Maya')).toBe(true)
    expect(looksLikeChatImport('hey whats up')).toBe(false)
  })
  it('acknowledges the import', () => {
    expect(handleChatImport()).toContain('importing')
  })
})

describe('smart features — billguard renewal radar (A7)', () => {
  it('finds recurring charges with amounts, period, and renew dates', () => {
    const hits = scanSubscriptions('Netflix renews on 8/30 at $15.49/month\nSpotify $11.99/mo')
    expect(hits.length).toBe(2)
    expect(hits.some((h) => h.merchant.toLowerCase().includes('netflix'))).toBe(true)
    expect(hits.some((h) => h.amount === 15.49)).toBe(true)
    expect(hits.some((h) => h.period === 'mo')).toBe(true)
  })
})

describe('smart features — travel real shift (A9)', () => {
  it('extracts destination and timezone', () => {
    expect(keepTravelPlan('travel mode to tokyo')).toEqual({ dest: 'tokyo', tz: 'Asia/Tokyo' })
    expect(keepTravelPlan('flying to paris next week')?.dest).toBe('paris')
  })
})

describe('smart features — debrief answers (A6)', () => {
  it('splits commitments into promises, decisions, and follow-ups', () => {
    const items = parseMeetingAnswer('I promised to send the deck by Friday. We decided on Stripe. Follow up with Maria.')
    expect(items.promises.some((p) => p.toLowerCase().includes('deck'))).toBe(true)
    expect(items.decisions.some((d) => d.toLowerCase().includes('stripe'))).toBe(true)
    expect(items.followups.some((f) => f.toLowerCase().includes('maria'))).toBe(true)
  })
})

describe('smart features — sweep batch approval (A3)', () => {
  it('parses send, edit, and skip choices', () => {
    expect(parseSweepApproval('1,3', 3)).toEqual({ action: 'send', indices: [1, 3] })
    expect(parseSweepApproval('send all', 3)).toEqual({ action: 'send_all' })
    expect(parseSweepApproval('edit 2', 3)).toEqual({ action: 'edit', index: 2 })
    expect(parseSweepApproval('skip 2', 3)).toEqual({ action: 'skip', indices: [2] })
    expect(parseSweepApproval('maybe later', 3)).toBeNull()
  })
})

describe('workshop dedup key', () => {
  it('normalizes differently-phrased asks to the same key', async () => {
    const { workshopTemplateKey } = await import('./liveContext')
    expect(workshopTemplateKey('can you build a pomodoro timer')).toBe('pomodoro timer')
    expect(workshopTemplateKey('build me a Pomodoro Timer!')).toBe('pomodoro timer')
    expect(workshopTemplateKey('could you write a password saver')).toBe('password saver')
    expect(workshopTemplateKey('build something')).toBe('something')
    expect(workshopTemplateKey('build a')).toBe('')
  })
})
