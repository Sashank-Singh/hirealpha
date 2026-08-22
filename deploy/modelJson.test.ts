import { describe, expect, it } from 'bun:test'
import { extractJsonObject, extractNumericFields, modelReplyText, stripReasoning } from './modelJson'

describe('stripReasoning', () => {
  it('drops a paired think block and keeps the answer', () => {
    expect(stripReasoning('<think>maybe 200</think>{"calories":650}')).toBe('{"calories":650}')
  })

  it('handles the thinking and reasoning spellings', () => {
    expect(stripReasoning('<thinking>a</thinking> b')).toBe('b')
    expect(stripReasoning('<reasoning>a</reasoning> b')).toBe('b')
  })

  it('keeps what follows an orphan close tag', () => {
    expect(stripReasoning('half a thought</think>{"calories":650}')).toBe('{"calories":650}')
  })

  it('keeps what precedes an orphan open tag', () => {
    expect(stripReasoning('{"calories":650} <think>wait, maybe more')).toBe('{"calories":650}')
  })

  it('leaves an ordinary reply alone', () => {
    expect(stripReasoning('  {"calories":650}  ')).toBe('{"calories":650}')
    expect(stripReasoning('')).toBe('')
  })
})

describe('modelReplyText', () => {
  it('prefers content', () => {
    expect(modelReplyText({ content: '{"calories":650}', reasoning_content: 'noise' })).toBe('{"calories":650}')
  })

  it('falls back to the scratchpad when content is empty', () => {
    expect(modelReplyText({ content: '', reasoning_content: '{"calories":650}' })).toBe('{"calories":650}')
  })

  it('returns the draft when the whole reply was scratchpad', () => {
    const got = modelReplyText({ content: '<think>call it {"calories":200}</think>' })
    expect(got).toContain('calories')
  })

  it('is empty for a missing message', () => {
    expect(modelReplyText(undefined)).toBe('')
    expect(modelReplyText(null)).toBe('')
    expect(modelReplyText({ content: null, reasoning_content: null })).toBe('')
  })
})

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"guess":"burrito","calories":650}')).toEqual({ guess: 'burrito', calories: 650 })
  })

  it('reads a fenced object', () => {
    const reply = 'Here you go:\n```json\n{"guess":"burrito","calories":650}\n```\nHope that helps.'
    expect(extractJsonObject(reply, ['calories'])).toEqual({ guess: 'burrito', calories: 650 })
  })

  it('reads an object wrapped in prose', () => {
    const reply = 'Estimate: {"guess":"burrito","calories":650}. Let me know if the portion was bigger.'
    expect(extractJsonObject(reply, ['calories'])).toEqual({ guess: 'burrito', calories: 650 })
  })

  it('ignores draft braces inside a leaked scratchpad', () => {
    const reply = '<think>a small one is {"calories":200}</think>{"guess":"burrito","calories":650}'
    expect(extractJsonObject(reply, ['calories'])?.calories).toBe(650)
  })

  it('skips an object that lacks the wanted key', () => {
    const reply = '{"error":"unclear"}\n{"guess":"burrito","calories":650}'
    expect(extractJsonObject(reply, ['calories'])?.calories).toBe(650)
    expect(extractJsonObject('{"error":"unclear"}', ['calories'])).toBeNull()
  })

  it('keeps nested values', () => {
    expect(extractJsonObject('{"per":{"unit":"cup"},"calories":10}', ['calories'])).toEqual({
      per: { unit: 'cup' },
      calories: 10,
    })
  })

  it('closes an object truncated after a value', () => {
    const cut = '{"guess":"chicken burrito","calories":650,"protein":32,"carbs":71,"fat":2'
    expect(extractJsonObject(cut, ['calories'])).toEqual({
      guess: 'chicken burrito',
      calories: 650,
      protein: 32,
      carbs: 71,
      fat: 2,
    })
  })

  it('drops back to the last comma when truncated mid key', () => {
    const cut = '{"guess":"burrito","calories":650,"prot'
    expect(extractJsonObject(cut, ['calories'])).toEqual({ guess: 'burrito', calories: 650 })
  })

  it('drops a dangling comma', () => {
    expect(extractJsonObject('{"calories":650,', ['calories'])).toEqual({ calories: 650 })
  })

  it('closes an open string', () => {
    expect(extractJsonObject('{"guess":"chicken bur')).toEqual({ guess: 'chicken bur' })
  })

  it('will not invent a wanted key to satisfy a repair', () => {
    expect(extractJsonObject('{"guess":"chicken bur', ['calories'])).toBeNull()
  })

  it('reaches inside an array wrapper for the object', () => {
    expect(extractJsonObject('[{"guess":"burrito","calories":650}]', ['calories'])?.calories).toBe(650)
  })

  it('refuses junk and silence', () => {
    expect(extractJsonObject('I cannot estimate that.')).toBeNull()
    expect(extractJsonObject('[1,2,3]')).toBeNull()
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject('<think>only thinking</think>')).toBeNull()
  })

  it('gives up on a string with a raw newline, which is not JSON', () => {
    // Left to extractNumericFields — the numbers are still there to read.
    expect(extractJsonObject('{"guess":"chicken\nburrito","calories":650}', ['calories'])).toBeNull()
  })
})

describe('extractNumericFields', () => {
  const KEYS = ['calories', 'protein', 'carbs', 'fat']

  it('reads labelled numbers out of unparseable JSON', () => {
    const got = extractNumericFields('{"guess":"chicken\nburrito","calories":650,"protein":32}', KEYS)
    expect(got).toEqual({ calories: 650, protein: 32 })
  })

  it('reads them out of markdown prose', () => {
    const got = extractNumericFields('**Calories** — 640 kcal · protein 32 g · carbs = 71g · fat 21', KEYS)
    expect(got).toEqual({ calories: 640, protein: 32, carbs: 71, fat: 21 })
  })

  it('reads them out of a scratchpad when that is all there is', () => {
    expect(extractNumericFields('<think>roughly calories 480 then</think>', KEYS)).toEqual({ calories: 480 })
  })

  it('keeps a real zero', () => {
    expect(extractNumericFields('{"guess":"black coffee","calories":0,"protein":0}', KEYS)).toEqual({
      calories: 0,
      protein: 0,
    })
  })

  it('takes decimals and signs', () => {
    expect(extractNumericFields('fat: 2.5', ['fat'])).toEqual({ fat: 2.5 })
  })

  it('does not reach past its own value into the next number', () => {
    const got = extractNumericFields('calories are unknown for this meal; protein 30', KEYS)
    expect(got).toEqual({ protein: 30 })
  })

  it('omits what the reply never said', () => {
    expect(extractNumericFields('calories 100', KEYS)).toEqual({ calories: 100 })
  })
})
