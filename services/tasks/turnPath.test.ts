import { describe, expect, it } from 'bun:test'
import { seedProjection, type TaskOption, type TaskProjection } from './taskContract'
import { appendEvent, createTask, loadProjection } from './taskStore'
import { interpretChoice, offerChoices, selectionNextStep, type ResearchCandidate } from './turnPath'

type Row = Record<string, unknown>

/**
 * Stateful fake copied from the taskStore suite's fake: implements just the
 * shapes taskStore emits so choiceTurns.publishOptions can run end to end.
 */
function fakeTaskDb() {
  const tasks = new Map<string, Row>()
  const events: Row[] = []

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    if (text.includes('INSERT INTO hire_tasks')) {
      const row: Row = {
        id: `task-${tasks.size + 1}`,
        user_id: values[0],
        persona: values[1],
        conversation_id: values[2] ?? null,
        request: values[3],
        state: 'DRAFT',
        resumed_state: null,
        monitor_state: 'OFF',
        monitor_policy: null,
        monitor_next_check_at: null,
        plan_version: 0,
        plan: null,
        current_step: null,
        constraints: '{}',
        options: '[]',
        selected_option_id: null,
        grants: '[]',
        external_ops: '[]',
        artifacts: '[]',
        verification: null,
        sync_state: '{}',
        failure: null,
        version: 0,
        event_seq: 0,
        created_at: '2026-09-14T00:00:00Z',
        updated_at: '2026-09-14T00:00:00Z',
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
        state, resumed_state: resumed, constraints, monitor_state: monitorState,
        monitor_policy: monitorPolicy, monitor_next_check_at: monitorNext,
        plan_version: planVersion, plan, current_step: currentStep, options,
        selected_option_id: selected, grants, external_ops: ops, artifacts,
        verification, sync_state: sync, failure,
        version: Number(row.version) + 1, event_seq: seq,
      })
      return Promise.resolve([row])
    }
    if (text.includes('INSERT INTO hire_task_events')) {
      if (text.includes('causation_id')) {
        const [eventId, taskId, userId, type, actor, causation, correlation, idemKey, payload, seq] = values
        events.push({
          event_id: eventId, task_id: taskId, user_id: userId, schema_version: 1,
          type, actor, causation_id: causation, correlation_id: correlation,
          idempotency_key: idemKey, occurred_at: '2026-09-14T00:00:01Z', payload, task_seq: seq,
        })
      } else {
        const [eventId, taskId, userId, type, actor, payload, seq] = values
        events.push({
          event_id: eventId, task_id: taskId, user_id: userId, schema_version: 1,
          type, actor, causation_id: null, correlation_id: null, idempotency_key: null,
          occurred_at: '2026-09-14T00:00:00Z', payload, task_seq: seq,
        })
      }
      return Promise.resolve([events[events.length - 1]])
    }
    if (text.includes('FROM hire_task_events') && text.includes('idempotency_key =')) {
      const [taskId, idemKey] = values
      return Promise.resolve(events.filter((e) => e.task_id === taskId && e.idempotency_key === idemKey).slice(0, 1))
    }
    if (text.includes('FROM hire_task_events')) {
      const [taskId, userId, afterSeq] = values
      return Promise.resolve(
        events
          .filter((e) => e.task_id === taskId && e.user_id === userId && Number(e.task_seq) > Number(afterSeq))
          .sort((a, b) => Number(a.task_seq) - Number(b.task_seq)),
      )
    }
    if (text.includes('FROM hire_tasks') && text.includes('ORDER BY updated_at')) {
      const all = [...tasks.values()]
      if (text.includes('WHERE user_id')) return Promise.resolve(all.filter((row) => row.user_id === values[0]))
      return Promise.resolve(all)
    }
    if (text.includes('FROM hire_tasks')) {
      const [taskId, userId] = values
      const row = tasks.get(String(taskId))
      return Promise.resolve(row && row.user_id === userId ? [row] : [])
    }
    throw new Error(`fakeTaskDb: unmatched query: ${text.slice(0, 120)}`)
  }) as { begin: (cb: (tx: never) => Promise<unknown>) => Promise<unknown> }
  sql.begin = (cb) => cb(sql as never)

  return { sql: sql as never, tasks, events }
}

/** A task parked in RESEARCHING, ready for offerChoices to publish from. */
async function researchingTask() {
  const db = fakeTaskDb()
  const task = await createTask(db.sql, {
    userId: 'user-1',
    request: 'find a dinner spot friday',
    persona: 'friend',
    conversationId: '+15550001111',
  })
  await appendEvent(db.sql, {
    userId: 'user-1', taskId: task.id, type: 'state_changed',
    payload: { to: 'RESEARCHING' }, actor: 'alpha',
  })
  return { db, taskId: task.id }
}

const NOW = new Date('2026-09-14T18:00:00Z')

function valid(title: string, url: string, price: number | null = null): ResearchCandidate {
  return {
    title,
    reason: `${title} fits your budget and is near you`,
    source_url: url,
    freshness: '2026-09-14T17:55:00Z',
    ...(price !== null ? { price_cents: price, currency: 'USD' } : {}),
  }
}

/* ------------------------------------------------------------ offerChoices */

describe('offerChoices', () => {
  it('publishes legal candidates as numbered cards and moves the task', async () => {
    const { db, taskId } = await researchingTask()
    const result = await offerChoices(db.sql, {
      userId: 'user-1',
      taskId,
      heading: 'dinner friday',
      candidates: [valid('Handlebar', 'https://yelp.com/handlebar'), valid('Cinque', 'https://resy.com/cinque')],
      now: NOW,
    })
    expect(result.published).toBe(true)
    expect(result.rendered).not.toBe(null)
    expect(result.rendered).toContain('1. Handlebar')
    expect(result.rendered).toContain('2. Cinque')
    const projection = await loadProjection(db.sql, { userId: 'user-1', taskId })
    expect(projection?.state).toBe('WAITING_FOR_SELECTION')
    expect(projection?.options.map((o) => o.id)).toEqual(['opt-1', 'opt-2'])
    expect(db.events.some((e) => e.type === 'options_published')).toBe(true)
  })

  it('dedups the same host+path across vendors and keeps the cheapest', async () => {
    const { db, taskId } = await researchingTask()
    const result = await offerChoices(db.sql, {
      userId: 'user-1',
      taskId,
      heading: 'rideshare home',
      candidates: [
        valid('Uber listed', 'https://www.uber.com/rides/airport?ref=partner', 4200),
        valid('Uber direct', 'https://uber.com/rides/airport/', 3100),
        valid('Lyft', 'https://lyft.com/rides/airport', 2800),
      ],
      now: NOW,
    })
    expect(result.published).toBe(true)
    expect(result.rendered).toContain('1. Uber direct — $31')
    expect(result.rendered).toContain('2. Lyft')
    expect(result.rendered).not.toContain('Uber listed')
    const dupes = result.dropped.filter((d) => d.why === 'duplicate-source-url')
    expect(dupes).toEqual([{ title: 'Uber listed', why: 'duplicate-source-url' }])
  })

  it('drops candidates that cannot form a legal card, with reasons, without throwing', async () => {
    const { db, taskId } = await researchingTask()
    const result = await offerChoices(db.sql, {
      userId: 'user-1',
      taskId,
      heading: 'dinner friday',
      candidates: [
        { ...valid('No Link', 'https://x.test/a'), source_url: null },
        { ...valid('Plain Http', 'http://x.test/b'), source_url: 'http://x.test/b' },
        { ...valid('No Reason', 'https://x.test/c'), reason: '   ' },
        { ...valid('Old Stamp', 'https://x.test/d'), freshness: 'last tuesday-ish' },
        valid('Keeper', 'https://x.test/e'),
      ],
      now: NOW,
    })
    expect(result.published).toBe(true)
    expect(result.rendered).toContain('1. Keeper')
    expect(result.dropped).toEqual([
      { title: 'No Link', why: 'missing-source-url' },
      { title: 'Plain Http', why: 'source-url-not-https' },
      { title: 'No Reason', why: 'missing-reason' },
      { title: 'Old Stamp', why: 'missing-or-unparseable-freshness' },
    ])
  })

  it('drops malformed price and currency instead of half-normalizing the card', async () => {
    const { db, taskId } = await researchingTask()
    const result = await offerChoices(db.sql, {
      userId: 'user-1',
      taskId,
      heading: 'gifts',
      candidates: [
        { ...valid('Fractional', 'https://x.test/f'), price_cents: 42.5 },
        { ...valid('Negative', 'https://x.test/g'), price_cents: -100 },
        { ...valid('Bad Currency', 'https://x.test/h'), price_cents: 100, currency: 'DOLLARS' },
        valid('Priced Right', 'https://x.test/i', 1500),
      ],
      now: NOW,
    })
    expect(result.dropped.map((d) => d.why)).toEqual(['invalid-price-cents', 'invalid-price-cents', 'invalid-currency'])
    expect(result.rendered).toContain('Priced Right — $15')
  })

  it('all-invalid candidates degrade gracefully: nothing published, nothing thrown', async () => {
    const { db, taskId } = await researchingTask()
    const result = await offerChoices(db.sql, {
      userId: 'user-1',
      taskId,
      heading: 'dinner friday',
      candidates: [
        { title: 'Ghost', reason: 'vibes', freshness: '2026-09-14T17:55:00Z' },
        { title: 'Stale', reason: 'vibes', source_url: 'https://x.test/j', freshness: 'someday' },
      ],
      now: NOW,
    })
    expect(result).toEqual({
      rendered: null,
      published: false,
      dropped: [
        { title: 'Ghost', why: 'missing-source-url' },
        { title: 'Stale', why: 'missing-or-unparseable-freshness' },
      ],
    })
    const projection = await loadProjection(db.sql, { userId: 'user-1', taskId })
    expect(projection?.state).toBe('RESEARCHING')
    expect(db.events.some((e) => e.type === 'options_published')).toBe(false)
  })

  it('empty and missing candidate lists come back clean, never a crash', async () => {
    const { db, taskId } = await researchingTask()
    expect(await offerChoices(db.sql, { userId: 'user-1', taskId, heading: 'dinner', candidates: [], now: NOW }))
      .toEqual({ rendered: null, published: false, dropped: [] })
    expect(await offerChoices(db.sql, { userId: 'user-1', taskId, heading: 'dinner', candidates: undefined as unknown as ResearchCandidate[], now: NOW }))
      .toEqual({ rendered: null, published: false, dropped: [] })
  })

  it('accepts epoch-ms freshness structurally and never fabricates a stamp', async () => {
    const { db, taskId } = await researchingTask()
    const result = await offerChoices(db.sql, {
      userId: 'user-1',
      taskId,
      heading: 'latency',
      candidates: [
        { ...valid('Epoch', 'https://x.test/k'), freshness: Date.parse('2026-09-14T17:59:00Z') },
        { ...valid('Nan Stamp', 'https://x.test/l'), freshness: Number.NaN },
      ],
      now: NOW,
    })
    expect(result.published).toBe(true)
    expect(result.dropped).toEqual([{ title: 'Nan Stamp', why: 'missing-or-unparseable-freshness' }])
    const projection = await loadProjection(db.sql, { userId: 'user-1', taskId })
    expect(projection?.options[0]?.freshness).toBe('2026-09-14T17:59:00.000Z')
  })
})

/* ---------------------------------------------------------- interpretChoice */

function projectionWithOptions(options: TaskOption[], state: TaskProjection['state'] = 'WAITING_FOR_SELECTION'): TaskProjection {
  return { ...seedProjection('find dinner friday', 'friend', '+15550001111'), state, options }
}

function card(id: string, title: string, freshness: string): TaskOption {
  return { id, title, reason: 'fits you', source_url: `https://x.test/${id}`, freshness, available: true }
}

describe('interpretChoice', () => {
  const fresh = card('a', 'Handlebar', '2026-09-14T17:50:00Z')
  const staleCard = card('b', 'Cinque', '2026-09-13T18:00:00Z')
  const projection = projectionWithOptions([fresh, staleCard])

  it('a fresh number reply chooses deterministically', () => {
    expect(interpretChoice(projection, '1', { now: NOW })).toEqual({ kind: 'choose', optionId: 'a' })
    expect(interpretChoice(projection, ' first ', { now: NOW })).toEqual({ kind: 'choose', optionId: 'a' })
  })

  it('a day-old price is stale, not selected', () => {
    expect(interpretChoice(projection, '2', { now: NOW })).toEqual({ kind: 'stale', optionId: 'b' })
    // Out of the default TTL but inside a longer one: freshness is caller-tuned.
    expect(interpretChoice(projection, '2', { now: NOW, ttlMs: 36 * 60 * 60_000 })).toEqual({ kind: 'choose', optionId: 'b' })
  })

  it('free prose always goes to the classifier', () => {
    for (const reply of ['compare them for me', 'actually Italian instead', 'eleven', '99', '', '2 and 3']) {
      expect(interpretChoice(projection, reply, { now: NOW })).toEqual({ kind: 'ask-classifier' })
    }
  })

  it('never mutates the projection — it is pure', () => {
    const before = JSON.stringify(projection)
    interpretChoice(projection, '1', { now: NOW })
    expect(JSON.stringify(projection)).toBe(before)
  })
})

/* -------------------------------------------------------- selectionNextStep */

describe('selectionNextStep', () => {
  const priced = card('p', 'Uber direct', '2026-09-14T17:55:00Z')
  priced.price_cents = 3100
  const soldOut = { ...card('s', 'Handlebar', '2026-09-14T17:55:00Z'), available: false }
  const unpriced = card('u', 'Reserve by phone', '2026-09-14T17:55:00Z')

  it('an available non-purchase card is ready with no authority', () => {
    const projection = projectionWithOptions([unpriced])
    expect(selectionNextStep(projection, unpriced)).toEqual({ ready: true })
  })

  it('a purchase-shaped card gates on an explicit granted authority', () => {
    const projection = projectionWithOptions([priced])
    expect(selectionNextStep(projection, priced, { requiredAuthority: true })).toEqual({ ready: false, reason: 'need-authority' })
    // A requested (not granted) or revoked grant is not authority.
    const pending = { ...projection, grants: [{ grant_id: 'g1', status: 'requested' as const }] }
    expect(selectionNextStep(pending, priced, { requiredAuthority: true })).toEqual({ ready: false, reason: 'need-authority' })
    const granted = { ...projection, grants: [{ grant_id: 'g1', status: 'granted' as const }] }
    expect(selectionNextStep(granted, priced, { requiredAuthority: true })).toEqual({ ready: true })
  })

  it('without the flag a priced card is not purchase-shaped — no prose guessing', () => {
    const projection = projectionWithOptions([priced])
    expect(selectionNextStep(projection, priced)).toEqual({ ready: true })
  })

  it('sold-out beats every other consideration', () => {
    const projection = projectionWithOptions([soldOut, priced], 'PLANNING_ACTION')
    projection.grants = [{ grant_id: 'g1', status: 'granted' }]
    expect(selectionNextStep(projection, soldOut, { requiredAuthority: true })).toEqual({ ready: false, reason: 'sold-out' })
  })

  it('a rejected or foreign option is unknown, never ready', () => {
    const rejected = { ...unpriced, rejected: true }
    const projection = projectionWithOptions([rejected])
    expect(selectionNextStep(projection, rejected)).toEqual({ ready: false, reason: 'unknown-option' })
    expect(selectionNextStep(projectionWithOptions([unpriced]), priced)).toEqual({ ready: false, reason: 'unknown-option' })
  })
})

/* ------------------------------------------------- end-to-end turn stitching */

describe('turn path end to end', () => {
  it('offer -> interpret choose -> next step gates on authority, then releases', async () => {
    const { db, taskId } = await researchingTask()
    const offer = await offerChoices(db.sql, {
      userId: 'user-1',
      taskId,
      heading: 'ride home',
      candidates: [valid('Uber', 'https://uber.com/rides/airport', 3100)],
      now: NOW,
    })
    expect(offer.published).toBe(true)

    const parked = await loadProjection(db.sql, { userId: 'user-1', taskId })
    expect(parked?.state).toBe('WAITING_FOR_SELECTION')
    const chosen = interpretChoice(parked!, '1', { now: NOW })
    expect(chosen).toEqual({ kind: 'choose', optionId: 'opt-1' })

    const option = parked!.options[0]!
    expect(selectionNextStep(parked!, option, { requiredAuthority: true })).toEqual({ ready: false, reason: 'need-authority' })

    const withGrant = { ...parked!, grants: [{ grant_id: 'g-ride', status: 'granted' as const }] }
    expect(selectionNextStep(withGrant, option, { requiredAuthority: true })).toEqual({ ready: true })
  })
})
