import { describe, expect, it } from 'bun:test'
import { runToolsForMessage } from './hire-api'
import { handleProposalRoutes } from './routes/proposals'
import { handleReminderRoutes } from './routes/reminders'
import { handleHabitRoutes } from './routes/habits'
import type { SQL } from './hire-api'
import { beforeEach, afterEach } from 'bun:test'

describe('State-changing tool and endpoint idempotency', () => {
  const origGmi = process.env.GMI_API_KEY
  const origNut = process.env.NUTRITION_API_KEY
  const origHire = process.env.HIREALPHA_API_KEY

  beforeEach(() => {
    delete process.env.GMI_API_KEY
    delete process.env.NUTRITION_API_KEY
    delete process.env.HIREALPHA_API_KEY
  })

  afterEach(() => {
    if (origGmi) process.env.GMI_API_KEY = origGmi
    if (origNut) process.env.NUTRITION_API_KEY = origNut
    if (origHire) process.env.HIREALPHA_API_KEY = origHire
  })
  it('runToolsForMessage reuses results when idempotencyKey is supplied', async () => {
    const mockSql = (() => []) as unknown as SQL

    const input = {
      userId: 'user-idempotent-tool',
      persona: 'friend' as const,
      message: 'weather in Seattle',
      connected: [],
      want: 'weather' as const,
      idempotencyKey: 'idemp-tool-run-123',
    }

    // First call
    const res1 = await runToolsForMessage(mockSql, input)
    // Second call with same idempotencyKey
    const res2 = await runToolsForMessage(mockSql, input)

    expect(res1).toEqual(res2)
  })

  it('/api/internal/propose returns deduplicated draft on repeat call', async () => {
    const insertedDrafts: any[] = []
    const mockSql = (async (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join('')
      if (q.includes('SELECT id, kind FROM hire_drafts')) {
        if (insertedDrafts.length > 0) {
          return [{ id: insertedDrafts[0].id, kind: insertedDrafts[0].kind }]
        }
        return []
      }
      if (q.includes('INSERT INTO hire_drafts')) {
        const id = values[0]
        const kind = values[3]
        insertedDrafts.push({ id, kind })
        return []
      }
      return []
    }) as unknown as SQL

    const options = {
      internalOk: () => true,
      livePayload: async () => ({ found: true, hired: true, userId: 'usr-prop-1' }),
      gmailReplyMeta: async () => null,
    }

    const payload = {
      phone: '+15551234567',
      persona: 'friend',
      kind: 'email',
      to: 'friend@example.com',
      subject: 'Catch up',
      body: 'Hey let us get coffee',
      idempotencyKey: 'key-prop-coffee-1',
    }

    const req1 = new Request('http://localhost/api/internal/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const res1 = await handleProposalRoutes(req1, mockSql, options)
    expect(res1?.status).toBe(200)
    const data1 = (await res1?.json()) as any
    expect(data1.ok).toBe(true)
    expect(data1.id).toBeDefined()
    expect(insertedDrafts.length).toBe(1)

    // Repeat identical request
    const req2 = new Request('http://localhost/api/internal/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const res2 = await handleProposalRoutes(req2, mockSql, options)
    expect(res2?.status).toBe(200)
    const data2 = (await res2?.json()) as any
    expect(data2.ok).toBe(true)
    expect(data2.id).toBe(data1.id)
    // No duplicate insert into database
    expect(insertedDrafts.length).toBe(1)
  })

  it('/api/internal/reminders prevents duplicate reminder creation on retry', async () => {
    const insertedReminders: any[] = []
    const mockSql = (async (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join('')
      if (q.includes('FROM hire_users')) {
        return [{ id: 'user-rem-1', phone_e164: '+15550001111' }]
      }
      if (q.includes('SELECT id, scheduled_at AS "scheduledAt" FROM hire_reminders')) {
        if (insertedReminders.length > 0) {
          return [insertedReminders[0]]
        }
        return []
      }
      if (q.includes('INSERT INTO hire_reminders')) {
        const id = values[0]
        const text = values[3]
        insertedReminders.push({ id, text, scheduledAt: new Date(), recurrence: 'once' })
        return []
      }
      return []
    }) as unknown as SQL

    const payload = {
      phone: '+15550001111',
      persona: 'friend',
      text: 'Call accountant',
      scheduledAt: '2026-09-26T15:00:00Z',
      idempotencyKey: 'idemp-rem-1234',
    }

    const req1 = new Request('http://localhost/api/internal/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const res1 = await handleReminderRoutes(req1, mockSql, { internalOk: () => true })
    expect(res1?.status).toBe(200)
    const data1 = (await res1?.json()) as any
    expect(data1.ok).toBe(true)
    expect(insertedReminders.length).toBe(1)

    // Retry
    const req2 = new Request('http://localhost/api/internal/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const res2 = await handleReminderRoutes(req2, mockSql, { internalOk: () => true })
    expect(res2?.status).toBe(200)
    const data2 = (await res2?.json()) as any
    expect(data2.ok).toBe(true)
    expect(data2.reminder.id).toBe(data1.reminder.id)
    expect(insertedReminders.length).toBe(1)
  })

  it('/api/internal/nutrition prevents duplicate nutrition logs on retry', async () => {
    const insertedNutrition: any[] = []
    const mockSql = (async (strings: TemplateStringsArray, ...values: any[]) => {
      const q = strings.join('')
      if (q.includes('FROM hire_users')) {
        return [{ id: 'user-nut-1', phone_e164: '+15550002222' }]
      }
      if (q.includes('SELECT id, description, calories FROM hire_nutrition_logs')) {
        if (insertedNutrition.length > 0) {
          return [insertedNutrition[0]]
        }
        return []
      }
      if (q.includes('INSERT INTO hire_nutrition_logs')) {
        const id = values[0]
        insertedNutrition.push({ id, description: '2 eggs and avocado toast', calories: 450 })
        return []
      }
      return []
    }) as unknown as SQL

    const payload = {
      phone: '+15550002222',
      persona: 'friend',
      description: '2 eggs and avocado toast',
      idempotencyKey: 'idemp-nut-1234',
    }

    const req1 = new Request('http://localhost/api/internal/nutrition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const res1 = await handleHabitRoutes(req1, mockSql, { internalOk: () => true })
    expect(res1?.status).toBe(200)
    const data1 = (await res1?.json()) as any
    expect(data1.ok).toBe(true)
    expect(insertedNutrition.length).toBe(1)

    // Retry
    const req2 = new Request('http://localhost/api/internal/nutrition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const res2 = await handleHabitRoutes(req2, mockSql, { internalOk: () => true })
    expect(res2?.status).toBe(200)
    const data2 = (await res2?.json()) as any
    expect(data2.ok).toBe(true)
    expect(data2.id).toBe(data1.id)
    expect(insertedNutrition.length).toBe(1)
  })
})
