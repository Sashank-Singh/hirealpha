import { describe, expect, it } from 'bun:test'
import { isOpenableMail, mailScanOnlyFrom } from './briefMail'
import type { BriefMailGroup } from './briefStory'

const replyGroup = (ids: string[]): BriefMailGroup[] => [
  { kind: 'reply', label: 'Waiting on you', count: ids.length, items: ids.map((id, i) => ({ id, label: `Sender ${i} · Subject ${i}` })) },
]

describe('isOpenableMail', () => {
  it('only trusts real Gmail ids', () => {
    expect(isOpenableMail('18f2c9d1a4b5e6f7')).toBe(true)
    expect(isOpenableMail('text-0')).toBe(false)
    expect(isOpenableMail('')).toBe(false)
    expect(isOpenableMail(undefined)).toBe(false)
  })
})

describe('mailScanOnlyFrom', () => {
  it('flags a reply pile that came from the text-only scan', () => {
    expect(mailScanOnlyFrom(replyGroup(['text-0', 'text-1']))).toBe(true)
  })

  it('leaves real rows alone', () => {
    expect(mailScanOnlyFrom(replyGroup(['18f2c9d1a4b5e6f7']))).toBe(false)
    expect(mailScanOnlyFrom([{ kind: 'promo', label: 'Promotions', count: 1, items: [{ id: 'text-3', label: 'A · B' }] }])).toBe(false)
    expect(mailScanOnlyFrom([])).toBe(false)
    expect(mailScanOnlyFrom(undefined)).toBe(false)
  })
})
