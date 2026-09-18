import { describe, expect, it } from 'bun:test'
import { coerceCount, coerceMoney, extractJsonArray, extractJsonObject, matchingJsonEnd, readField } from './jsonExtract'

describe('extractJsonObject', () => {
  /* Our generators ask for {"title","code"} and parsed it with a greedy
   * /\\{[\\s\\S]*\\}/ — one stray brace in the prose and the whole build died. */
  it('finds the object through prose, fences and braces in the text', () => {
    expect(extractJsonObject('Sure! Here is the program {not json} and now the real one: {"title":"Pong","code":"x"}')).toEqual({ title: 'Pong', code: 'x' })
    expect(extractJsonObject('```json\n{"title":"Pong","code":"a {b} c"}\n```')).toEqual({ title: 'Pong', code: 'a {b} c' })
    expect(extractJsonObject('<think>maybe {"x":1}</think>{"title":"T","code":"y"}')).toEqual({ title: 'T', code: 'y' })
  })

  it('returns null when there is no usable object', () => {
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('{"broken": ')).toBeNull()
  })
})

describe('extractJsonArray', () => {
  it('skips a prose array and takes the rows', () => {
    const out = extractJsonArray('I checked ["price","airline"] first, then found [{"price":189,"airline":"Delta"}]')
    expect(out).toEqual([{ price: 189, airline: 'Delta' }])
  })

  it('returns an empty array when the model said so', () => {
    expect(extractJsonArray('No flights matched. []')).toEqual([])
  })
})

describe('matchingJsonEnd', () => {
  it('ignores brackets inside strings', () => {
    const text = '{"a":"} not the end","b":{"c":1}}'
    const end = matchingJsonEnd(text, 0, '{', '}')
    expect(text.slice(0, end + 1)).toBe(text)
  })
})

describe('coerceMoney', () => {
  /* The old code compared "$1,189" > 0, which is NaN, so every row dropped. */
  it('reads money the way models write it', () => {
    expect(coerceMoney('$1,189')).toBe(1189)
    expect(coerceMoney('USD 1,189.50')).toBe(1189.5)
    expect(coerceMoney('1.189,50')).toBe(1189.5)
    expect(coerceMoney('189pp')).toBe(189)
    expect(coerceMoney(189)).toBe(189)
  })

  it('refuses what is not a price', () => {
    expect(coerceMoney('free')).toBe(0)
    expect(coerceMoney('')).toBe(0)
    expect(coerceMoney(-5)).toBe(0)
  })
})

describe('coerceCount and readField', () => {
  it('reads stop counts however they are spelled', () => {
    expect(coerceCount('nonstop')).toBe(0)
    expect(coerceCount('1 stop')).toBe(1)
    expect(coerceCount(2)).toBe(2)
    expect(coerceCount('many')).toBeNull()
  })

  it('finds a field under its aliases', () => {
    expect(readField({ total_price: 300 }, 'price', ['total_price'])).toBe(300)
    expect(readField({}, 'price', ['total_price'])).toBeUndefined()
  })
})
