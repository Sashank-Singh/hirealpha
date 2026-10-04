import { afterEach, describe, expect, it } from 'bun:test'
import { estimateNutrition, nutritionModelConfig } from './habits/parsers'

const originalFetch = globalThis.fetch
const envKeys = ['NUTRITION_API_KEY', 'NUTRITION_BASE_URL', 'NUTRITION_MODEL', 'NUTRITION_VISION_MODEL']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
const meal = '2 Eggo protein waffles, 2 Deep paneer parathas, 8-9 scoops Snickers ice cream, 1 pack Hershey chocolate pretzels'
const macros = { guess: meal, calories: 1800, protein: 60, carbs: 210, fat: 80 }
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function replies(contents: string[]) {
  process.env.NUTRITION_API_KEY = 'test'
  const requests: Array<{ max_tokens: number; messages: Array<{ content: unknown }> }> = []
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: contents.shift() ?? '' } }] })
  }) as typeof fetch
  return requests
}

describe('nutrition estimate recovery', () => {
  it('normalizes the same GLM model for Novita and honors the nutrition key', () => {
    process.env.NUTRITION_API_KEY = 'nutrition-test'
    process.env.NUTRITION_BASE_URL = 'https://api.novita.ai/v3/openai'
    process.env.NUTRITION_MODEL = 'zai-org/GLM-5.3-Flash'
    process.env.NUTRITION_VISION_MODEL = 'zai-org/GLM-5.3-Flash'
    expect(nutritionModelConfig()).toMatchObject({
      apiKey: 'nutrition-test', textModel: 'zai-org/glm-5.3-flash', visionModel: 'zai-org/glm-5.3-flash',
    })
    process.env.NUTRITION_BASE_URL = 'https://openrouter.ai/api/v1'
    expect(nutritionModelConfig()?.textModel).toBe('z-ai/glm-5.3-flash')
    process.env.NUTRITION_BASE_URL = 'https://api.gmi-serving.com/v1'
    expect(nutritionModelConfig()?.textModel).toBe('zai-org/GLM-5.3-Flash')
  })

  it('does not estimate an unseen photo after vision fails', async () => {
    const requests = replies(['', ''])
    expect((await estimateNutrition('meal from photo', '/9j/' + 'a'.repeat(100))).ok).toBe(false)
    expect(requests).toHaveLength(2)
    expect(requests.every((r) => JSON.stringify(r.messages).includes('image_url'))).toBe(true)
  })

  it('does not treat scratchpad macros as a final answer', async () => {
    replies([`<think>${JSON.stringify(macros)}</think>`, `<think>${JSON.stringify(macros)}</think>`])
    expect((await estimateNutrition(meal, '')).ok).toBe(false)
  })

  it('retries an empty completion with room for reasoning and all meal portions', async () => {
    const requests = replies(['', JSON.stringify(macros)])
    expect(await estimateNutrition(meal, '')).toEqual({ ok: true, ...macros })
    expect(requests).toHaveLength(2)
    expect(requests[1]!.max_tokens).toBeGreaterThan(requests[0]!.max_tokens)
    expect(JSON.stringify(requests[0]!.messages)).toContain(meal)
  })

  it('does not turn missing macros into zeroes', async () => {
    replies(['{"calories":1800}', '{"calories":1800}'])
    const result = await estimateNutrition(meal, '')
    expect(result.ok).toBe(false)
    expect(result.calories).toBeUndefined()
    expect(result.error).toContain('try again')
  })

  it('keeps legitimate zero calorie estimates', async () => {
    replies(['{"guess":"Water","calories":0,"protein":0,"carbs":0,"fat":0}'])
    expect(await estimateNutrition('Water', '')).toEqual({ ok: true, guess: 'Water', calories: 0, protein: 0, carbs: 0, fat: 0 })
  })
})
