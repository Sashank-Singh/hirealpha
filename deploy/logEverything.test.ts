import { afterEach, describe, expect, it } from 'bun:test'
import { handleHireApi } from './hire-api'
import { detectMiniAppRequest } from '../spectrum/shared/miniApps'
import { parseNetworkContact } from '../spectrum/shared/liveContext'
import {
  looksLikeGratitudeLog,
  looksLikeHabitDone,
  looksLikeMoodReply,
  looksLikeNutritionLog,
  looksLikeSleepLog,
  looksLikeSpendLog,
  looksLikeWorkoutLog,
} from '../spectrum/shared/runHireTurn'

/* ---- "Can I log everything from chat?" — the truth table ----
 * Each row is a real thing the user might text. For each one this asserts the
 * whole chain that was broken before: the bot routes the text to the right
 * mini-app kind, the turn-level gate accepts the phrasing, and the internal
 * endpoint the bot calls writes into the exact table the app reads back. */

const KEY_ENV = ['GMI_API_KEY', 'NUTRITION_API_KEY', 'HIREALPHA_API_KEY', 'NUTRITION_BASE_URL', 'GMI_BASE_URL', 'HIREALPHA_BASE_URL']
for (const k of KEY_ENV) delete process.env[k]

const USER = {
  id: 'u-test',
  email: 'a@b.co',
  name: 'Alpha',
  timezone: 'America/Los_Angeles',
  phone: '+15551234567',
  phone_e164: '+15551234567',
}

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?')))
  }) as never
  return { sql, queries }
}

const rows = (text: string) => {
  if (/FROM hire_users/i.test(text)) return [USER]
  // 'done meditation' needs a habit to exist before it can be logged.
  if (/FROM hire_habits/i.test(text)) return [{ id: 'h1', name: 'meditation' }]
  return []
}

function internalPost(path: string, body: unknown) {
  return new Request(`https://hirealpha.chat${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  delete process.env.HIREALPHA_INTERNAL_KEY
})

describe('log everything from chat — end to end routing', () => {
  it('save this link → Learning Queue row', async () => {
    const link = 'getting into YC F25: after the fact https://x.com/wen_rahme/status/1'
    expect(detectMiniAppRequest('Save this', 'friend', [link])).toEqual({ kind: 'learning_queue' })

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(
      internalPost('/api/internal/learning', { phone: USER.phone, persona: 'friend', url: 'https://x.com/wen_rahme/status/1', title: 'getting into YC F25: after the fact' }),
      sql,
    )
    expect(res?.status).toBe(200)
    const insert = queries.find((q) => /INSERT INTO hire_learning/i.test(q.text))
    expect(insert).toBeTruthy()
    expect(insert!.values.map(String).join(' ')).toContain('x.com')
  })

  it('"I met Priya at dinner, her number is…" → CRM row', async () => {
    const text = 'I met Priya at dinner, her number is 415-555-0100'
    expect(detectMiniAppRequest(text, 'friend')).toEqual({ kind: 'networking_crm' })
    expect(parseNetworkContact(text)?.name).toBe('Priya')
    expect(parseNetworkContact(text)?.place).toBe('dinner')
    expect(parseNetworkContact(text)?.phone).toContain('415')

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(
      internalPost('/api/internal/network', { phone: USER.phone, persona: 'friend', name: 'Priya', place: 'dinner', contactPhone: '415-555-0100', text }),
      sql,
    )
    expect(res?.status).toBe(200)
    const insert = queries.find((q) => /INSERT INTO hire_network/i.test(q.text))
    expect(insert).toBeTruthy()
    expect(insert!.values.map(String).join(' ')).toContain('Priya')
    expect(insert!.values.map(String).join(' ')).toContain('415-555-0100')
  })

  it('"I ate a burger and fries" → nutrition row, even without a model key', async () => {
    const text = 'I ate a burger and fries'
    expect(detectMiniAppRequest(text, 'friend')).toEqual({ kind: 'nutrition' })
    expect(looksLikeNutritionLog(text)).toBe(true)

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(
      internalPost('/api/internal/nutrition', { phone: USER.phone, persona: 'friend', description: text }),
      sql,
    )
    const data = (await res?.json()) as { logged?: boolean }
    expect(data.logged).toBe(true)
    const insert = queries.find((q) => /INSERT INTO hire_nutrition_logs/i.test(q.text))
    expect(insert!.values.map(String).join(' ')).toContain('burger')
  })

  it('"I worked out bench press 3x5 135" → workout row with the lifts', async () => {
    const text = 'I worked out bench press 3x5 135'
    expect(detectMiniAppRequest(text, 'friend')).toEqual({ kind: 'workout_log' })
    expect(looksLikeWorkoutLog(text)).toBe(true)

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(
      internalPost('/api/internal/workouts', { phone: USER.phone, persona: 'friend', text }),
      sql,
    )
    expect(res?.status).toBe(200)
    const insert = queries.find((q) => /INSERT INTO hire_workouts/i.test(q.text))
    expect(insert).toBeTruthy()
    const joined = insert!.values.map(String).join(' ')
    expect(joined).toContain('bench press')
    expect(joined).toContain('135')
  })

  it('"log my spend $12 on lunch" → spending row', async () => {
    const text = 'log my spend $12 on lunch'
    expect(detectMiniAppRequest(text, 'friend')).toEqual({ kind: 'spending_snapshot' })
    expect(looksLikeSpendLog(text)).toBe(true)

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(internalPost('/api/internal/spending', { phone: USER.phone, persona: 'friend', text }), sql)
    expect(res?.status).toBe(200)
    const insert = queries.find((q) => /INSERT OR UPDATE|UPDATE hire_spending|INSERT INTO hire_spending/i.test(q.text))
    expect(insert).toBeTruthy()
    expect(insert!.values.map(String).join(' ')).toContain('12')
  })

  it('"sleep last night 1am to 7am" → sleep row', async () => {
    const text = 'sleep last night 1am to 7am'
    expect(detectMiniAppRequest(text, 'friend')).toEqual({ kind: 'sleep_tracker' })
    expect(looksLikeSleepLog(text)).toBe(true)

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(internalPost('/api/internal/sleep', { phone: USER.phone, persona: 'friend', text }), sql)
    expect(res?.status).toBe(200)
    const insert = queries.find((q) => /INSERT INTO hire_sleep/i.test(q.text))
    expect(insert).toBeTruthy()
    expect(insert!.values.map(String).join(' ')).toContain('01:00')
  })

  it('"grateful for the call today" → gratitude row', async () => {
    const text = 'grateful for the call today'
    expect(detectMiniAppRequest(text, 'friend')).toEqual({ kind: 'gratitude_journal' })
    expect(looksLikeGratitudeLog(text)).toBe(true)

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(internalPost('/api/internal/gratitude', { phone: USER.phone, persona: 'friend', text }), sql)
    expect(res?.status).toBe(200)
    const insert = queries.find((q) => /INSERT INTO hire_gratitude/i.test(q.text))
    expect(insert!.values.map(String).join(' ')).toContain('call today')
  })

  it('"😄" → mood row (works even without a mini-app match)', async () => {
    expect(looksLikeMoodReply('😄')).toBe(true)

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(internalPost('/api/internal/moods', { phone: USER.phone, persona: 'friend', emoji: '😄' }), sql)
    expect(res?.status).toBe(200)
    expect(queries.some((q) => /INSERT INTO hire_moods/i.test(q.text))).toBe(true)
  })

  it('"done meditation" → habit log row', async () => {
    expect(looksLikeHabitDone('done meditation')).toBe(true)

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(internalPost('/api/internal/habits/done', { phone: USER.phone, persona: 'friend', text: 'done meditation' }), sql)
    expect(res?.status).toBe(200)
    const insert = queries.find((q) => /INSERT INTO hire_habit_logs/i.test(q.text))
    expect(insert).toBeTruthy()
    // The log references the matched habit by id (the fake seeded id h1).
    expect(insert!.values.map(String).join(' ')).toContain('h1')
  })
})
