import { expect, it } from 'bun:test'
import { handleReminderRoutes } from './routes/reminders'

function request(body: Record<string, unknown>) {
  return new Request('https://test.invalid/api/internal/reminders', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

it('UX06 creates a new occurrence when an old reminder with the same text is completed', async () => {
  let inserted = false
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join('?')
    if (query.includes('FROM hire_users')) return [{ id: 'u1' }]
    if (query.includes('SELECT id, scheduled_at')) return []
    if (query.includes('INSERT INTO hire_reminders')) { inserted = true; return [] }
    return []
  }) as any
  const response = await handleReminderRoutes(request({
    phone: '+15555550123', persona: 'friend', text: 'call mom',
    scheduledAt: '2026-09-28T16:00:00Z', recurrence: 'once', idempotencyKey: 'new-occurrence',
  }), sql, { internalOk: () => true })
  const data = await response!.json()
  expect(inserted).toBe(true)
  expect(data.reminder).toMatchObject({ scheduledAt: '2026-09-28T16:00:00.000Z', recurrence: 'once', text: 'call mom' })
})

it('UX06 deduplicates only an identical pending occurrence', async () => {
  const queries: string[] = []
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join('?'); queries.push(query)
    if (query.includes('FROM hire_users')) return [{ id: 'u1' }]
    if (query.includes('SELECT id, scheduled_at')) return [{ id: 'same', scheduledAt: new Date('2026-09-28T16:00:00Z'), recurrence: 'once', text: 'call mom', status: 'pending' }]
    return []
  }) as any
  const response = await handleReminderRoutes(request({
    phone: '+15555550123', persona: 'friend', text: 'call mom', scheduledAt: '2026-09-28T16:00:00Z', recurrence: 'once', idempotencyKey: 'same-occurrence',
  }), sql, { internalOk: () => true })
  expect(await response!.json()).toMatchObject({ deduplicated: true, reminder: { id: 'same', scheduledAt: '2026-09-28T16:00:00.000Z' } })
  const lookup = queries.find((query) => query.includes('SELECT id, scheduled_at'))!
  expect(lookup).toContain("status = 'pending'")
  expect(lookup).toContain('scheduled_at =')
})
