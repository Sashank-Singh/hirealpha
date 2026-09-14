import { describe, expect, it } from 'bun:test'
import { isRecipientSendBlocked } from './judgment'
import { looksLikeNutritionLog, statesFood } from './runHireTurn'

describe('statesFood: stated meals auto-log without an ask', () => {
  it('fires on a direct "I ate" statement', () => {
    expect(statesFood('I ate 2 Popeyes chicken tenders and fries and a biscuit and Diet Coke')).toBe(true)
    expect(statesFood('i had biryani last night')).toBe(true)
    expect(statesFood('We just had tacos')).toBe(true)
  })
  it('fires on "lunch was X"', () => {
    expect(statesFood('lunch was a sandwich')).toBe(true)
  })
  it('does not fire on questions or unrelated text', () => {
    expect(statesFood('what should I eat for lunch?')).toBe(false)
    expect(statesFood('did I log lunch today')).toBe(false)
    expect(statesFood('find me a dinner spot in the Loop')).toBe(false)
  })
  it('still matches the broad nutrition-log detector', () => {
    expect(looksLikeNutritionLog('I ate 2 Popeyes chicken tenders')).toBe(true)
  })
})

describe('isRecipientSendBlocked covers Photon target walls', () => {
  it('treats "Target not allowed for this project" as blocked (freeze, not retry)', () => {
    const err = Object.assign(new Error('PERMISSION_DENIED: [spectrum-imessage] Target not allowed for this project'), { code: 7 })
    expect(isRecipientSendBlocked(err)).toBe(true)
  })
  it('keeps matching the original cooling-down wall', () => {
    expect(isRecipientSendBlocked(new Error('RecipientCoolingDown'))).toBe(true)
  })
  it('does not swallow unrelated errors', () => {
    expect(isRecipientSendBlocked(new Error('ECONNRESET'))).toBe(false)
  })
})
