/**
 * Canonical-journey integration test (docs/strategy/beat-instinct-plan.md,
 * "Canonical user journey" section) — the release check that the Phase 1/2
 * modules actually compose into the one promise: ask -> clarify -> research
 * with memory-cited cards -> choose -> authority -> execute -> verify by
 * receipt -> calendar-sync without duplicates -> monitoring trail.
 *
 * No transports, no clocks from the wild: every time is injected, the
 * provider is a spy, and the database is the same stateful fake the unit
 * suites use (taskStore.test.ts pattern, local copy).
 */
import { describe, expect, it } from 'bun:test'
import type { SQL } from 'bun'
import { appendEvent, createTask, loadProjection, rebuildProjection } from './taskStore'
import { publishOptions, selectOption, handOffToExecutor } from './choiceTurns'
import { parsePrefFacts, preferenceWhy } from './memoryHints'
import { scheduleMonitoring, triggerOnce } from './monitoring'
import { recordReceipt, evaluateReceipt } from './receipts'
import { buildCalendarDraft, syncVerifiedReservation, type CalendarProvider } from './calendarSync'

type Row = Record<string, unknown>

function fakeWorld() {
  const tasks = new Map<string, Row>()
  const events: Row[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    if (text.includes('INSERT INTO hire_tasks')) {
      const row: Row = {
        id: `task-${tasks.size + 1}`, user_id: values[0], persona: values[1], conversation_id: values[2] ?? null,
        request: values[3], state: 'DRAFT', resumed_state: null, monitor_state: 'OFF', monitor_policy: null,
        monitor_next_check_at: null, plan_version: 0, plan: null, current_step: null, constraints: '{}',
        options: '[]', selected_option_id: null, grants: '[]', external_ops: '[]', artifacts: '[]',
        verification: null, sync_state: '{}', failure: null, version: 0, event_seq: 0,
        created_at: '2026-09-14T18:00:00Z', updated_at: '2026-09-14T18:00:00Z',
      }
      tasks.set(String(row.id), row)
      return Promise.resolve([row])
    }
    if (text.includes('UPDATE hire_tasks') && text.includes('SET version = 1')) {
      const row = tasks.get(String(values[0]))
      if (row) Object.assign(row, { version: 1, event_seq: 1 })
      return Promise.resolve(row ? [row] : [])
    }
    if (text.includes('UPDATE hire_tasks') && text.includes('SET state')) {
      const [state, resumed, constraints, monitorState, monitorPolicy, monitorNext, planVersion, plan, currentStep, options, selected, grants, ops, artifacts, verification, sync, failure, seq, taskId, userId, expectedVersion] = values
      const row = tasks.get(String(taskId))
      if (!row || row.user_id !== userId || row.version !== expectedVersion) return Promise.resolve([])
      Object.assign(row, {
        state, resumed_state: resumed, constraints, monitor_state: monitorState, monitor_policy: monitorPolicy,
        monitor_next_check_at: monitorNext, plan_version: planVersion, plan, current_step: currentStep, options,
        selected_option_id: selected, grants, external_ops: ops, artifacts, verification, sync_state: sync, failure,
        version: Number(row.version) + 1, event_seq: seq,
      })
      return Promise.resolve([row])
    }
    if (text.includes('INSERT INTO hire_task_events')) {
      const row = text.includes('causation_id')
        ? { event_id: values[0], task_id: values[1], user_id: values[2], schema_version: 1, type: values[3], actor: values[4], causation_id: values[5], correlation_id: values[6], idempotency_key: values[7], occurred_at: '2026-09-14T18:00:01Z', payload: values[8], task_seq: values[9] }
        : { event_id: values[0], task_id: values[1], user_id: values[2], schema_version: 1, type: values[3], actor: values[4], causation_id: null, correlation_id: null, idempotency_key: null, occurred_at: '2026-09-14T18:00:01Z', payload: values[5], task_seq: values[6] }
      events.push(row)
      return Promise.resolve([row])
    }
    if (text.includes('FROM hire_task_events') && text.includes('idempotency_key =')) {
      const [taskId, idemKey] = values
      return Promise.resolve(events.filter((e) => e.task_id === taskId && e.idempotency_key === idemKey).slice(0, 1))
    }
    if (text.includes('FROM hire_task_events')) {
      const [taskId, userId, afterSeq] = values
      return Promise.resolve(
        events.filter((e) => e.task_id === taskId && e.user_id === userId && Number(e.task_seq) > Number(afterSeq ?? 0))
          .sort((a, b) => Number(a.task_seq) - Number(b.task_seq)),
      )
    }
    if (text.includes('FROM hire_tasks')) {
      const [taskId, userId] = values
      const row = tasks.get(String(taskId))
      return Promise.resolve(row && row.user_id === userId ? [row] : [])
    }
    throw new Error(`journey fake: unmatched query: ${text.slice(0, 100)}`)
  }) as { begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
  sql.begin = (cb) => cb(sql)
  return { sql: sql as SQL, events, tasks }
}

const NOW = new Date('2026-09-14T18:00:00.000Z')

describe('canonical journey end-to-end', () => {
  it('text-to-verified-booked-synced-monitored completes across all modules', async () => {
    const { sql, events } = fakeWorld()
    const userId = 'user-j'

    // 1. Ask + clarified constraints.
    const task = await createTask(sql, { userId, request: 'book a friday dinner for two under $40', persona: 'friend' })
    await appendEvent(sql, { userId, taskId: task.id, type: 'constraints_resolved', payload: { constraints: { day: 'friday', party: 2, budget_cents: 4000 } }, actor: 'alpha' })
    await appendEvent(sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'CLARIFYING' }, actor: 'alpha' })
    await appendEvent(sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'alpha' })

    // 2. Research -> cards, reason cites memory (workstream 7 rule); the
    // sensitive fact must never leak its key into the rendered card.
    const facts = parsePrefFacts([
      { key: 'food.budget', kind: 'explicit', value_ref: 'mem:food.budget', confidence: 1, source: 'said', sensitive: false },
      { key: 'health.dietary', kind: 'explicit', value_ref: 'mem:health.dietary', confidence: 1, source: 'said', sensitive: true },
    ])
    const reason = preferenceWhy('walkable and under your cap, vegetarian-friendly.', facts)
    expect(reason).toContain('from: food.budget')
    expect(reason).not.toContain('health.dietary')
    const cards = [
      { id: 'handlebar', title: 'Handlebar', price_cents: 3200, currency: 'USD', reason, source_url: 'https://resy.test/handlebar', freshness: NOW.toISOString(), cancellation: 'free until 2h' },
      { id: 'planta', title: 'PLANTA Queen', price_cents: 5100, currency: 'USD', reason: 'rooftop, walkable', source_url: 'https://resy.test/planta', freshness: NOW.toISOString() },
    ]
    const rendered = await publishOptions(sql, { userId, taskId: task.id, heading: 'Chicago Friday dinner', options: cards, now: NOW })
    expect(rendered).toContain('Reply a number')
    let projection = await loadProjection(sql, { userId, taskId: task.id })
    expect(projection?.state).toBe('WAITING_FOR_SELECTION')

    // 3. User chooses the affordable card; hand off to executor; authority.
    const chosen = await selectOption(sql, { userId, taskId: task.id, reply: '1', now: NOW })
    expect(chosen.outcome).toBe('selected')
    const handed = await handOffToExecutor(sql, { userId, taskId: task.id, enqueue: async () => 'job-777', now: NOW })
    expect(handed.ref).toBe('job-777')
    const grantId = 'approval:rest-1'
    await appendEvent(sql, { userId, taskId: task.id, type: 'authority_requested', payload: { grant_id: grantId }, actor: 'alpha' })
    await appendEvent(sql, { userId, taskId: task.id, type: 'authority_granted', payload: { grant_id: grantId }, actor: 'user' })
    await appendEvent(sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'EXECUTING', grant_id: grantId }, actor: 'alpha' })

    // 4. A standing watch survives the run (orthogonal monitor).
    const watched = await scheduleMonitoring(sql, {
      userId, taskId: task.id, now: NOW,
      policy: { watch: { kind: 'price', target: 'https://resy.test/handlebar', condition: { metric: 'price_cents', threshold_cents: 4000 } }, cadenceMinutes: 30, autoAct: true, authorityGrantId: grantId } as never,
    })
    expect(watched.task.monitor_state).toBe('SCHEDULED')
    const fired = await triggerOnce(sql, { userId, taskId: task.id, now: NOW, evidenceRefs: [`price:${NOW.toISOString()}`], autoAct: true, grantedCheck: () => true })
    expect(fired.act).toBe('act')

    // 5. Run done -> execution-side verification -> receipt verification.
    await appendEvent(sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'VERIFYING' }, actor: 'alpha' })
    const half = evaluateReceipt('purchase', { confirmation_id: 'ORD-77', items: 'two seats', payment_status: 'paid' })
    expect(half.verdict).toBe('incomplete') // missing total -> never verified
    const receipt = await recordReceipt(sql, {
      userId, taskId: task.id, taskClass: 'purchase',
      evidence: { confirmation_id: 'ORD-77', items: 'two seats', total_cents: 3200, payment_status: 'paid' },
      idempotencyKey: 'receipt:job-777',
    })
    expect(receipt.verdict).toBe('verified')
    projection = await loadProjection(sql, { userId, taskId: task.id })
    expect(projection?.state).toBe('SYNCHRONIZING')

    // 6. Calendar sync: first webhook delivers, replay suppresses (exit gate).
    let providerWrites = 0
    const provider: CalendarProvider = { write: async () => { providerWrites += 1; return 'written' } }
    const draft = buildCalendarDraft({ kind: 'reservation', title: 'Dinner - Handlebar', providerConfirmation: 'ORD-77', start_at: '2026-09-18T23:00:00Z', end_at: '2026-09-19T01:00:00Z', location: 'Chicago', cancellationTerms: 'free until 2h', taskId: task.id })
    const first = await syncVerifiedReservation(sql, { userId, taskId: task.id, draft, provider })
    expect(first.action).toBe('created')
    expect(providerWrites).toBe(1)
    const replay = await syncVerifiedReservation(sql, { userId, taskId: task.id, draft, provider })
    expect(replay.action).toBe('suppressed')
    expect(providerWrites).toBe(1) // never a second entry
    projection = await loadProjection(sql, { userId, taskId: task.id })
    expect(projection?.sync_state.calendar?.status).toBe('delivered')

    // 7. Fulfill + close; the rebuilt stream equals the stored projection.
    await appendEvent(sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'FULFILLED' }, actor: 'alpha' })
    await appendEvent(sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'CLOSED' }, actor: 'alpha' })
    const stored = await loadProjection(sql, { userId, taskId: task.id })
    const rebuilt = await rebuildProjection(sql, { userId, taskId: task.id })
    expect(stored?.state).toBe('CLOSED')
    expect(rebuilt?.state).toBe('CLOSED')
    expect(rebuilt?.selected_option_id).toBe('handlebar')
    expect(rebuilt?.verification?.passed).toBe(true)
    expect(rebuilt?.monitor_state).toBe('TRIGGERED')

    // 8. Terminal: nothing writes anymore (contract law).
    await expect(appendEvent(sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'EXECUTING' }, actor: 'rogue' })).rejects.toThrow('terminal')
    const before = events.length
    await syncVerifiedReservation(sql, { userId, taskId: task.id, draft, provider }).catch(() => undefined)
    expect(providerWrites).toBe(1)
    expect(events.length).toBeLessThanOrEqual(before + 2) // sync claim may log; calendar write count is the law
  })
})
