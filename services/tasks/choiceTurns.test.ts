import { describe, expect, it } from 'bun:test'
import type { TaskOption } from './taskContract'
import { TaskTransitionError } from './taskContract'
import { appendEvent, createTask, listEvents, loadProjection } from './taskStore'
import { handOffToExecutor, publishOptions, rejectOption, selectOption } from './choiceTurns'

type Row = Record<string, unknown>

/**
 * Stateful fake: implements just the shapes taskStore emits (copied from the
 * taskStore suite's fake; rows store JSONB as values the readers accept).
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

/* Fixed world: cards checked at 18:00Z, "now" at 18:05Z (fresh) or 19:00Z (an
 * hour old — past the 15-minute card TTL). No live clock in any assertion. */
const FRESHNESS = '2026-09-14T18:00:00Z'
const NOW = new Date('2026-09-14T18:05:00Z')
const LATE = new Date('2026-09-14T19:00:00Z')

function card(id: string, title: string, priceCents: number): TaskOption {
  return {
    id,
    title,
    reason: 'top rated and vegetarian friendly',
    source_url: `https://resy.test/${id}`,
    source_label: 'Resy',
    freshness: FRESHNESS,
    price_cents: priceCents,
    currency: 'USD',
  }
}

const CARDS: TaskOption[] = [card('opt-1', 'Octopi', 4200), card('opt-2', 'Scareta', 5600)]

/** A task already parked in RESEARCHING, ready to publish cards from. */
async function researchingTask() {
  const db = fakeTaskDb()
  const task = await createTask(db.sql, {
    userId: 'user-1',
    request: 'book a table at the italian place friday',
    persona: 'friend',
    conversationId: '+15550001111',
  })
  await appendEvent(db.sql, {
    userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'alpha',
  })
  return { db, taskId: task.id }
}

/** ...and one with cards already published, waiting on the user's reply. */
async function awaitingSelection() {
  const { db, taskId } = await researchingTask()
  const text = await publishOptions(db.sql, { userId: 'user-1', taskId, heading: 'dinner friday', options: CARDS, now: NOW })
  return { db, taskId, text: text as string }
}

async function stateOf(db: ReturnType<typeof fakeTaskDb>, taskId: string) {
  const projection = await loadProjection(db.sql, { userId: 'user-1', taskId })
  return projection
}

async function eventTypes(db: ReturnType<typeof fakeTaskDb>, taskId: string): Promise<string[]> {
  return (await listEvents(db.sql, { userId: 'user-1', taskId })).map((event) => event.type)
}

describe('choice turns', () => {
  it('publishes cards: returns the rendered text, stores the cards, parks WAITING_FOR_SELECTION', async () => {
    const { db, taskId, text } = await awaitingSelection()
    expect(text).toContain("Here's what I found — dinner friday:")
    expect(text).toContain('1. Octopi — $42')
    expect(text).toContain('2. Scareta — $56')
    expect(text).toContain('https://resy.test/opt-1')
    expect(text).toContain('Reply a number to pick one')
    const projection = await stateOf(db, taskId)
    expect(projection?.state).toBe('WAITING_FOR_SELECTION')
    expect(projection?.options.map((option) => option.id)).toEqual(['opt-1', 'opt-2'])
  })

  it('a card without provenance throws at the contract and stores nothing', async () => {
    const { db, taskId } = await researchingTask()
    const before = db.events.length
    const noSource = { id: 'opt-x', title: 'Ghost place', reason: 'looks nice', freshness: FRESHNESS } as TaskOption
    await expect(
      publishOptions(db.sql, { userId: 'user-1', taskId, heading: 'dinner', options: [noSource], now: NOW }),
    ).rejects.toThrow('source_url')
    expect(db.events).toHaveLength(before)
    const projection = await stateOf(db, taskId)
    expect(projection?.state).toBe('RESEARCHING')
    expect(projection?.options).toHaveLength(0)
  })

  it('render refusing (no live cards to show) returns null and publishes nothing', async () => {
    const { db, taskId } = await researchingTask()
    const text = await publishOptions(db.sql, { userId: 'user-1', taskId, heading: '   ', options: CARDS, now: NOW })
    expect(text).toBe(null)
    expect(await stateOf(db, taskId)).toMatchObject({ state: 'RESEARCHING' })
    expect(db.events.filter((event) => event.type === 'options_published')).toHaveLength(0)
  })

  it('a number reply on a fresh card selects it and moves to PLANNING_ACTION', async () => {
    const { db, taskId } = await awaitingSelection()
    const result = await selectOption(db.sql, { userId: 'user-1', taskId, reply: '2', now: NOW })
    expect(result).toMatchObject({ outcome: 'selected', optionId: 'opt-2' })
    if (result.outcome !== 'selected') throw new Error('unreachable')
    expect(result.task.state).toBe('PLANNING_ACTION')
    const projection = await stateOf(db, taskId)
    expect(projection?.state).toBe('PLANNING_ACTION')
    expect(projection?.selected_option_id).toBe('opt-2')
  })

  it('a number reply on a stale card reports stale and writes nothing', async () => {
    const { db, taskId } = await awaitingSelection()
    const result = await selectOption(db.sql, { userId: 'user-1', taskId, reply: '1', now: LATE })
    expect(result).toEqual({ outcome: 'stale', optionId: 'opt-1' })
    const projection = await stateOf(db, taskId)
    expect(projection?.state).toBe('WAITING_FOR_SELECTION')
    expect(projection?.selected_option_id).toBe(null)
    expect((await eventTypes(db, taskId)).filter((type) => type === 'option_selected')).toHaveLength(0)
  })

  it('a reply outside the grammar goes to the classifier, never a guess', async () => {
    const { db, taskId } = await awaitingSelection()
    const before = db.events.length
    const result = await selectOption(db.sql, { userId: 'user-1', taskId, reply: 'hmm not feeling italian, maybe thursday?', now: NOW })
    expect(result).toEqual({ outcome: 'needs-classifier' })
    expect(db.events).toHaveLength(before)
    expect((await stateOf(db, taskId))?.state).toBe('WAITING_FOR_SELECTION')
  })

  it('rejecting cards keeps selection until the last one goes, then re-researches', async () => {
    const { db, taskId } = await awaitingSelection()
    const partial = await rejectOption(db.sql, { userId: 'user-1', taskId, optionId: 'opt-1', reason: 'too pricey' })
    expect(partial.allRejected).toBe(false)
    expect(partial.task.state).toBe('WAITING_FOR_SELECTION')
    const final = await rejectOption(db.sql, { userId: 'user-1', taskId, optionId: 'opt-2' })
    expect(final.allRejected).toBe(true)
    expect(final.task.state).toBe('RESEARCHING')
    const projection = await stateOf(db, taskId)
    expect(projection?.state).toBe('RESEARCHING')
    expect(projection?.options.every((option) => option.rejected === true)).toBe(true)
  })

  it('rejecting the selected option clears the selection in the reducer', async () => {
    const { db, taskId } = await awaitingSelection()
    await selectOption(db.sql, { userId: 'user-1', taskId, reply: '2', now: NOW })
    const result = await rejectOption(db.sql, { userId: 'user-1', taskId, optionId: 'opt-2' })
    expect(result.allRejected).toBe(false)
    const projection = await stateOf(db, taskId)
    expect(projection?.selected_option_id).toBe(null)
    // Still PLANNING_ACTION — only WAITING_FOR_SELECTION tasks re-research.
    expect(projection?.state).toBe('PLANNING_ACTION')
  })

  it('handoff enqueues the chosen card once, records the executor artifact, and parks WAITING_FOR_AUTHORITY', async () => {
    const { db, taskId } = await awaitingSelection()
    await selectOption(db.sql, { userId: 'user-1', taskId, reply: '2', now: NOW })
    const enqueued: TaskOption[] = []
    const result = await handOffToExecutor(db.sql, {
      userId: 'user-1', taskId, now: NOW,
      enqueue: async (option) => { enqueued.push(option); return 'queue:job-77' },
    })
    expect(enqueued.map((option) => option.id)).toEqual(['opt-2'])
    expect(result.ref).toBe('queue:job-77')
    expect(result.task.state).toBe('WAITING_FOR_AUTHORITY')
    const projection = await stateOf(db, taskId)
    expect(projection?.state).toBe('WAITING_FOR_AUTHORITY')
    expect(projection?.artifacts.some((a) => a.kind === 'executor' && a.ref === 'queue:job-77')).toBe(true)
    expect((await eventTypes(db, taskId)).filter((type) => type === 'state_changed')).toHaveLength(4)
  })

  it('handoff refuses before a selection exists and never calls enqueue', async () => {
    const { db, taskId } = await awaitingSelection()
    let calls = 0
    await expect(
      handOffToExecutor(db.sql, {
        userId: 'user-1', taskId,
        enqueue: async () => { calls += 1; return 'queue:job-nope' },
      }),
    ).rejects.toBeInstanceOf(TaskTransitionError)
    expect(calls).toBe(0)
    expect((await stateOf(db, taskId))?.state).toBe('WAITING_FOR_SELECTION')
  })
})
