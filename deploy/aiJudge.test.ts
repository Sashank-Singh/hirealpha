import { describe, expect, it } from 'bun:test'
import { judgeAllPrompt, judgeRowCovers, judgeRowFresh, parseJudgeAll } from './aiJudge'

/* ---- The judgment layer's pure half ----
 * One model call replaces the regex tiers: per-mail keep/kind/needsYou/score/
 * why/promise and per-meeting prep. These pin the prompt's contract and the
 * parser's tolerance, plus the cache freshness rules the brief's zero-call
 * open depends on. */

describe('judgeAllPrompt', () => {
  it('lists mail with ids and asks for the judgment fields', () => {
    const p = judgeAllPrompt(
      [{ id: 'g1', from: 'Priya Shah', subject: 'specs', snippet: 'can you send by Friday?' }],
      [],
    )
    expect(p).toContain('g1')
    expect(p).toContain('needsYou')
    expect(p).toContain('"mails"')
    expect(p).not.toContain('"meets"')
  })

  it('includes meetings and the meets reply shape when meetings exist', () => {
    const p = judgeAllPrompt([], [{ id: '10:00 AM|Investor intro', time: '10:00 AM', title: 'Investor intro' }])
    expect(p).toContain('Meetings today')
    expect(p).toContain('Investor intro')
    expect(p).toContain('"meets"')
  })

  it('offers the vocab piles to reuse', () => {
    const p = judgeAllPrompt([{ id: 'a', from: 'x', subject: 'y', snippet: 'z' }], [], ['take home', 'invoice'])
    expect(p).toContain('take home, invoice')
  })
})

describe('parseJudgeAll', () => {
  const mails = [
    { id: 'g1', from: 'Priya', subject: 'specs', snippet: '' },
    { id: 'g2', from: 'Billing', subject: 'invoice', snippet: '' },
  ]
  const meets = [{ id: '10:00 AM|Standup', time: '10:00 AM', title: 'Standup' }]

  it('parses the current shape and clamps scores', () => {
    const raw = JSON.stringify({
      mails: [
        { id: 'g1', keep: true, kind: 'take home', needsYou: true, score: 999, why: 'Priya wants an answer soon please' },
        { id: 'g2', keep: false, kind: 'invoice', needsYou: true, score: 85, why: 'invoice due tomorrow', promise: 'ACME sends payment by the 30th' },
      ],
      meets: [{ id: '10:00 AM|Standup', prep: false }],
    })
    const out = parseJudgeAll(raw, mails, meets)
    expect(out.mails.get('g1')?.score).toBe(100)
    expect(out.mails.get('g1')?.needsYou).toBe(true)
    expect(out.mails.get('g1')?.why).toBe('Priya wants an answer soon please')
    expect(out.mails.get('g2')?.keep).toBe(false)
    expect(out.mails.get('g2')?.promise).toBe('ACME sends payment by the 30th')
    expect(out.meets.get('10:00 AM|Standup')?.prep).toBe(false)
  })

  it('accepts numeric indexes instead of ids', () => {
    const raw = JSON.stringify({ mails: [{ id: 1, keep: true, kind: 'intro', needsYou: true, score: 70 }] })
    const out = parseJudgeAll(raw, mails, [])
    expect(out.mails.get('g1')?.kind).toBe('intro')
  })

  it('keeps the verdict on the right mail when the id is missing, by position', () => {
    const raw = JSON.stringify({
      mails: [
        { keep: true, kind: 'intro', needsYou: false, score: 20 },
        { keep: true, kind: 'invoice', needsYou: true, score: 90 },
      ],
    })
    const out = parseJudgeAll(raw, mails, [])
    expect(out.mails.get('g2')?.kind).toBe('invoice')
  })

  it('returns empty maps for a garbage reply and ignores unknown ids', () => {
    expect(parseJudgeAll('no json here', mails, []).mails.size).toBe(0)
    const out = parseJudgeAll(JSON.stringify({ mails: [{ id: 'zzz', keep: true, kind: 'x' }] }), mails, [])
    expect(out.mails.size).toBe(0)
  })

  it('recovers the JSON from narrated or fenced replies', () => {
    const raw =
      'Here is what I chose:\n' +
      '```json\n' +
      '{"mails":[{"id":"g1","keep":true,"kind":"intro","needsYou":true,"score":70}]}' +
      '\n```'
    const out = parseJudgeAll(raw, mails, meets)
    expect(out.mails.get('g1')?.kind).toBe('intro')
    expect(out.mails.get('g1')?.needsYou).toBe(true)
  })

  it('survives a closing brace inside a quoted reason and trailing commentary', () => {
    const raw =
      '{"mails":[{"id":"g2","keep":true,"kind":"invoice","needsYou":true,"score":85,"why":"send payment } Friday"}]} and also {"meets":[{"id":"10:00 AM|Standup","prep":true}]}'
    const out = parseJudgeAll(raw, mails, meets)
    expect(out.mails.get('g2')?.why).toBe('send payment } Friday')
    expect(out.meets.size).toBe(0)
  })

  it('takes the first object when the model emits several', () => {
    const raw =
      '{"mails":[{"id":"g1","keep":true,"kind":"intro"}]} then a retry {"mails":[{"id":"g1","keep":false,"kind":"promo"}]}'
    const out = parseJudgeAll(raw, mails, [])
    expect(out.mails.get('g1')?.kind).toBe('intro')
  })

  it('treats needsYou strings and missing keep as the tolerant old judge did', () => {
    const out = parseJudgeAll(JSON.stringify({ mails: [{ id: 'g1', needsYou: 'true' }] }), mails, [])
    expect(out.mails.get('g1')?.keep).toBe(true)
    expect(out.mails.get('g1')?.needsYou).toBe(true)
  })
})

describe('judge cache freshness', () => {
  const today = '2026-08-29'
  it('trusts a row built inside the TTL today', () => {
    expect(judgeRowFresh(Date.now() - 14 * 60_000, Date.now(), today, today)).toBe(true)
  })

  it('drops a row past fifteen minutes or from another day', () => {
    expect(judgeRowFresh(Date.now() - 16 * 60_000, Date.now(), today, today)).toBe(false)
    expect(judgeRowFresh(Date.now() - 60_000, Date.now(), '2026-08-28', today)).toBe(false)
    expect(judgeRowFresh(null, Date.now(), today, today)).toBe(false)
  })

  it('covers a batch when few ids are unseen, not when the cache is blind to it', () => {
    const cached = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(judgeRowCovers(cached, ['a', 'b', 'c', 'd', 'e', 'f'])).toBe(true)
    expect(judgeRowCovers(cached, ['a', 'b', 'c', 'd', 'e', 'f', 'x', 'y', 'z', 'w'])).toBe(false)
    expect(judgeRowCovers(null, ['a'])).toBe(false)
  })
})
