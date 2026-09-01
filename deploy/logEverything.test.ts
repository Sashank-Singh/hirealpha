import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
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
const savedKeyEnv = new Map<string, string | undefined>()
for (const k of KEY_ENV) savedKeyEnv.set(k, process.env[k])

beforeAll(() => {
  for (const k of KEY_ENV) delete process.env[k]
})

afterAll(() => {
  for (const [k, v] of savedKeyEnv) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

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

describe('cofounder decision from chat', () => {
  it('"log a decision: drop the agency, because 18k is a costume" → decisions row', async () => {
    const text = 'log a decision: drop the agency, because 18k is a costume'
    expect(detectMiniAppRequest(text, 'cofounder')).toEqual({ kind: 'decision_ledger' })

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(
      internalPost('/api/internal/decisions', { phone: USER.phone, persona: 'cofounder', text }),
      sql,
    )
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { logged?: boolean }
    expect(data.logged).toBe(true)
    const insert = queries.find((q) => /INSERT INTO hire_decisions/i.test(q.text))
    expect(insert).toBeTruthy()
    const joined = insert!.values.map(String).join(' ')
    expect(joined).toContain('drop the agency')
    expect(joined).toContain('18k is a costume')
  })

  it('"we decided to hire Ravi" also routes', async () => {
    const text = 'we decided to hire Ravi'
    expect(detectMiniAppRequest(text, 'cofounder')).toEqual({ kind: 'decision_ledger' })
  })
})

describe('cofounder pipeline from chat', () => {
  it('"move Ravi to interview" → pipeline row + stage', async () => {
    const text = 'move Ravi to interview'
    expect(detectMiniAppRequest(text, 'cofounder')).toEqual({ kind: 'pipeline_board' })

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(internalPost('/api/internal/pipeline', { phone: USER.phone, persona: 'cofounder', text }), sql)
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { logged?: boolean; stage?: string }
    expect(data.logged).toBe(true)
    expect(data.stage).toBe('interview')
    const insert = queries.find((q) => /INSERT INTO hire_pipeline/i.test(q.text))
    expect(insert).toBeTruthy()
    expect(insert!.values.map(String).join(' ')).toContain('Ravi')
  })

  it('"add Stripe as a lead" routes and stages', async () => {
    expect(detectMiniAppRequest('add Stripe as a lead', 'cofounder')).toEqual({ kind: 'pipeline_board' })
  })
})

describe('coworker standup from chat', () => {
  it('"standup: shipped the parser, reviewing Linda PR" → standup row for today', async () => {
    const text = 'standup: shipped the parser, reviewing Linda PR'
    expect(detectMiniAppRequest(text, 'coworker')).toEqual({ kind: 'standup_paste' })

    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(internalPost('/api/internal/standup', { phone: USER.phone, persona: 'coworker', text }), sql)
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { logged?: boolean }
    expect(data.logged).toBe(true)
    const insert = queries.find((q) => /INSERT INTO hire_standups/i.test(q.text))
    expect(insert).toBeTruthy()
    expect(insert!.values.map(String).join(' ')).toContain('shipped the parser')
  })
})

describe('work pull sections', () => {
  it('coworker pull has Linear + PRs + drafts', () => {
    const { workPullSections } = require('./hire-api') as typeof import('./hire-api')
    const s = workPullSections({
      persona: 'coworker',
      linear: [{ identifier: 'LIN-12', title: 'payments flake', state: 'In progress' }],
      prs: ['#3216 fix null check'],
      draftsCount: 2,
    })
    const flat = s.map((x) => x.title + '|' + x.lines.join(' ')).join('\n')
    expect(flat).toContain('Linear')
    expect(flat).toContain('LIN-12')
    expect(flat).toContain('PRs needing your pass')
    expect(flat).toContain('2 waiting')
  })

  it('cofounder pull has pipeline $ + decisions + runway', () => {
    const { workPullSections } = require('./hire-api') as typeof import('./hire-api')
    const s = workPullSections({
      persona: 'cofounder',
      pipeline: [{ stage: 'offer', value: 220000 }, { stage: 'active', value: 50000 }],
      decisionsOpen: 2,
      oldestDecisionDays: 5,
      runway: { cash: 530000, burn: 48000, months: 11 },
    })
    const flat = s.map((x) => x.title + '|' + x.lines.join(' ')).join('\n')
    expect(flat).toContain('Pipeline')
    expect(flat).toContain('$270k')
    expect(flat).toContain('1 offers out')
    expect(flat).toContain('Decisions')
    expect(flat).toContain('2 open')
    expect(flat).toContain('11 months')
  })
})

describe('workshop: build → keep → toss', () => {
  const code = `await Bun.write('out/index.html', '<h1>Invoice tracker</h1>')`

  it('"build me a tracker for my invoices" → artifact kind', () => {
    expect(detectMiniAppRequest('build me a tracker for my invoices', 'friend')).toEqual({ kind: 'artifact' })
    expect(detectMiniAppRequest('make a dashboard for sales', 'coworker')).toEqual({ kind: 'artifact' })
  })

  it('the build runs, stores the artifact, and returns the link', async () => {
    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(
      internalPost('/api/internal/workshop', { phone: USER.phone, persona: 'friend', prompt: 'build me a tracker for my invoices', title: 'Invoice tracker', code }),
      sql,
    )
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { logged?: boolean; artifactId?: string; files?: string[] }
    expect(data.logged).toBe(true)
    expect(data.files?.[0]).toBe('index.html')
    expect(queries.some((q) => /INSERT INTO hire_artifacts/i.test(q.text))).toBe(true)
    expect(queries.some((q) => /INSERT INTO hire_workshop_tasks/i.test(q.text))).toBe(true)
  })

  it('banned code is refused before running', async () => {
    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rows)
    const res = await handleHireApi(
      internalPost('/api/internal/workshop', { phone: USER.phone, persona: 'friend', title: 'evil', code: `require('child_process')` }),
      sql,
    )
    const data = (await res?.json()) as { ok?: boolean; error?: string }
    expect(data.ok).toBe(false)
    expect(data.error).toContain('sandbox does not allow')
    expect(queries.some((q) => /INSERT INTO hire_artifacts/i.test(q.text))).toBe(false)
  })

  it('toss deletes the artifact', async () => {
    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql((text) => {
      if (/FROM hire_users/i.test(text)) return [USER]
      if (/SELECT id, user_id FROM hire_artifacts/i.test(text)) return [{ id: 'art-1', user_id: USER.id }]
      if (/SELECT id FROM hire_artifacts/i.test(text)) return [{ id: 'art-1' }]
      return []
    })
    const res = await handleHireApi(
      internalPost('/api/internal/workshop/toss', { phone: USER.phone, persona: 'friend' }),
      sql,
    )
    expect(res?.status).toBe(200)
    expect(queries.some((q) => /DELETE FROM hire_artifacts/i.test(q.text))).toBe(true)
  })
})

describe('junk draft filter', () => {
  it('flags automated senders and subjects', () => {
    const { isAutomatedSender, isAutomatedSubject } = require('./hire-api') as typeof import('./hire-api')
    expect(isAutomatedSender('do-not-reply@coderbyte.com')).toBe(true)
    expect(isAutomatedSender('no-reply@turing.com')).toBe(true)
    expect(isAutomatedSender('notifications@linkedin.com')).toBe(true)
    expect(isAutomatedSender('linda@company.com')).toBe(false)
    expect(isAutomatedSubject('Unread message from Laura G. (PCC)')).toBe(true)
    expect(isAutomatedSubject('Re: Assessment submitted for Netic AI')).toBe(true)
    expect(isAutomatedSubject('quick question about the contract')).toBe(false)
  })
})
