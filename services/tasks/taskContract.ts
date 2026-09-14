/**
 * Canonical task contract (beat-instinct plan, "Task state machine" +
 * "Task and event contract"). Pure logic: no SQL, no I/O, no clocks.
 *
 * The event stream owns history; the projection (hire_tasks row) owns the
 * queryable state. Every state move is a `state_changed` event validated here,
 * including the plan's forbidden transitions:
 *   - WAITING_FOR_SELECTION -> EXECUTING without a selected option
 *   - WAITING_FOR_AUTHORITY -> EXECUTING without a valid scoped grant
 *   - EXECUTING             -> FULFILLED without independent outcome verification
 *   - NEEDS_RECONCILIATION  -> automatic retry when a side effect may have happened
 */

export const TASK_STATES = [
  'DRAFT',
  'CLARIFYING',
  'RESEARCHING',
  'WAITING_FOR_SELECTION',
  'PLANNING_ACTION',
  'WAITING_FOR_AUTHORITY',
  'EXECUTING',
  'VERIFYING',
  'SYNCHRONIZING',
  'FULFILLED',
  'CLOSED',
  'PAUSED_BY_USER',
  'CANCELLED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'NEEDS_RECONCILIATION',
  'HUMAN_TAKEOVER',
] as const
export type TaskState = (typeof TASK_STATES)[number]

/** Monitoring is orthogonal to execution state (plan: "Monitoring is orthogonal"). */
export const MONITOR_STATES = ['OFF', 'SCHEDULED', 'CHECKING', 'DEGRADED', 'TRIGGERED', 'ENDED'] as const
export type MonitorState = (typeof MONITOR_STATES)[number]

export const TERMINAL_STATES: readonly TaskState[] = ['CLOSED', 'CANCELLED', 'FAILED_FINAL']

/** Reachable from any non-terminal state; never from a terminal one. */
export const EXCEPTION_STATES: readonly TaskState[] = [
  'PAUSED_BY_USER',
  'CANCELLED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'NEEDS_RECONCILIATION',
  'HUMAN_TAKEOVER',
]

/** Reason codes are labels attached to a transition, not states (error/rescue registry). */
export const FAILURE_REASON_CODES = [
  'needs_clarification',
  'research_retryable',
  'no_current_options',
  'image_unverified',
  'browser_replan_required',
  'human_takeover_required',
  'credential_required',
  'payment_reapproval_required',
  'needs_reconciliation',
  'verification_failed',
  'sync_retryable',
  'delivery_retryable',
  'monitor_degraded',
] as const
export type FailureReasonCode = (typeof FAILURE_REASON_CODES)[number]

const FORWARD: Record<TaskState, readonly TaskState[]> = {
  DRAFT: ['CLARIFYING', 'RESEARCHING', 'PLANNING_ACTION', 'CANCELLED'],
  CLARIFYING: ['RESEARCHING'],
  RESEARCHING: ['WAITING_FOR_SELECTION'],
  WAITING_FOR_SELECTION: ['PLANNING_ACTION', 'RESEARCHING'],
  PLANNING_ACTION: ['WAITING_FOR_AUTHORITY', 'EXECUTING', 'RESEARCHING'],
  WAITING_FOR_AUTHORITY: ['EXECUTING', 'PLANNING_ACTION'],
  EXECUTING: ['VERIFYING'],
  VERIFYING: ['SYNCHRONIZING', 'EXECUTING'],
  SYNCHRONIZING: ['FULFILLED'],
  FULFILLED: ['CLOSED', 'RESEARCHING'],
  CLOSED: [],
  PAUSED_BY_USER: [],
  CANCELLED: [],
  FAILED_RETRYABLE: [],
  FAILED_FINAL: [],
  NEEDS_RECONCILIATION: ['VERIFYING', 'HUMAN_TAKEOVER'],
  HUMAN_TAKEOVER: ['EXECUTING', 'VERIFYING'],
}

/** Exception moves are legal from any non-terminal state (plan: "From any non-terminal state"). */
function exceptionEdge(from: TaskState, to: TaskState): boolean {
  return !TERMINAL_STATES.includes(from) && EXCEPTION_STATES.includes(to)
}

/** Paused / retryable tasks resume only to the state they fell out of. */
function resumeEdge(from: TaskState, to: TaskState, projection: TaskProjection): boolean {
  if (from !== 'PAUSED_BY_USER' && from !== 'FAILED_RETRYABLE') return false
  return to === projection.resumed_state && to !== null
}

export class TaskTransitionError extends Error {}

/**
 * Validate one state move. `payload` is the state_changed payload; the
 * projection is the current (pre-event) state. Throws TaskTransitionError on
 * any illegal or unguarded move.
 */
export function assertTransition(
  from: TaskState,
  to: TaskState,
  projection: TaskProjection,
  payload: StateChangedPayload,
): void {
  if (TERMINAL_STATES.includes(from)) {
    throw new TaskTransitionError(`Task is ${from}; no transition is allowed from a terminal state.`)
  }
  if (to === from) {
    throw new TaskTransitionError(`No-op transition (${from}) is not a valid state event.`)
  }
  const legal =
    FORWARD[from]?.includes(to) || resumeEdge(from, to, projection) || exceptionEdge(from, to)
  if (!legal) {
    throw new TaskTransitionError(`Forbidden transition: ${from} -> ${to}.`)
  }
  // Entering EXECUTING is the guarded door. A task that offered options must
  // have one selected; single-action tasks execute on authority alone.
  if (to === 'EXECUTING') {
    if (projection.options.length > 0 && !projection.selected_option_id) {
      throw new TaskTransitionError('Cannot execute without a selected option.')
    }
    if (from === 'WAITING_FOR_AUTHORITY') {
      const grantId = payload.grant_id
      if (!grantId) throw new TaskTransitionError('Cannot execute from WAITING_FOR_AUTHORITY without a grant id.')
      if (!isGranted(projection, grantId)) {
        throw new TaskTransitionError(`Cannot execute: grant ${grantId} is not in granted state.`)
      }
    } else if (from === 'PLANNING_ACTION' && payload.authority !== 'not_required') {
      throw new TaskTransitionError('Cannot execute: the action requires an authority decision first.')
    }
  }
  if (to === 'FULFILLED') {
    if (from !== 'SYNCHRONIZING') throw new TaskTransitionError('Tasks reach FULFILLED only from SYNCHRONIZING.')
    if (projection.verification?.passed !== true) {
      throw new TaskTransitionError('Cannot fulfill without recorded verification evidence.')
    }
  }
  if (to === 'SYNCHRONIZING' && projection.verification?.passed !== true) {
    throw new TaskTransitionError('Cannot synchronize completion without recorded verification evidence.')
  }
}

export function isGranted(projection: TaskProjection, grantId: string): boolean {
  return projection.grants.some((grant) => grant.grant_id === grantId && grant.status === 'granted')
}

/* ------------------------------------------------------------------ events */

export type TaskOption = {
  id: string
  title: string
  price_cents?: number | null
  currency?: string | null
  image_ref?: string | null
  reason?: string | null
  source_url?: string | null
  freshness?: string | null
  available?: boolean
  rejected?: boolean
}

export type GrantRef = { grant_id: string; status: 'requested' | 'granted' | 'revoked' | 'consumed' }
export type ExternalOp = { operation: string; idempotency_key: string; status: string; evidence_ref?: string | null }
export type Artifact = { kind: string; ref?: string | null; url?: string | null; at?: string }
export type SyncEntry = { status: string; ref?: string | null }

export type TaskProjection = {
  request: string
  persona: string
  conversation_id: string | null
  constraints: Record<string, unknown>
  state: TaskState
  resumed_state: TaskState | null
  monitor_state: MonitorState
  monitor_policy: unknown
  monitor_next_check_at: string | null
  plan_version: number
  plan: unknown
  current_step: unknown
  options: TaskOption[]
  selected_option_id: string | null
  grants: GrantRef[]
  external_ops: ExternalOp[]
  artifacts: Artifact[]
  verification: { passed: boolean; evidence: string[]; at?: string } | null
  sync_state: Record<string, SyncEntry>
  failure: { reason_code: string; detail?: string; at?: string } | null
}

export type StateChangedPayload = {
  to: TaskState
  grant_id?: string | null
  authority?: 'not_required' | null
  reason_code?: string | null
}

export type TaskEventInput =
  | { type: 'task_created'; payload: { request: string; persona?: string; conversation_id?: string | null } }
  | { type: 'constraints_resolved'; payload: { constraints: Record<string, unknown> } }
  | { type: 'options_published'; payload: { options: TaskOption[] } }
  | { type: 'option_selected'; payload: { option_id: string } }
  | { type: 'option_rejected'; payload: { option_id: string; reason?: string } }
  | { type: 'plan_published'; payload: { plan_version: number; plan: unknown; current_step?: unknown } }
  | { type: 'authority_requested'; payload: { grant_id: string } }
  | { type: 'authority_granted'; payload: { grant_id: string } }
  | { type: 'authority_revoked'; payload: { grant_id: string } }
  | { type: 'execution_started'; payload: { grant_id?: string; checkout?: Record<string, unknown> } }
  | { type: 'checkpoint_recorded'; payload: { step: unknown } }
  | { type: 'handoff_requested'; payload: { kind: string; ref: string } }
  | { type: 'handoff_resumed'; payload: { kind: string } }
  | { type: 'external_op_recorded'; payload: ExternalOp }
  | { type: 'artifact_recorded'; payload: Artifact }
  | { type: 'verification_recorded'; payload: { passed: boolean; evidence: string[]; at?: string } }
  | { type: 'sync_updated'; payload: { surface: string; status: string; ref?: string | null } }
  | { type: 'monitor_updated'; payload: { state: MonitorState; policy?: unknown; next_check_at?: string | null } }
  | { type: 'failure_recorded'; payload: { reason_code: string; detail?: string; at?: string } }
  | { type: 'state_changed'; payload: StateChangedPayload }

export type TaskEventType = TaskEventInput['type']
export const TASK_EVENT_TYPES: readonly TaskEventType[] = [
  'task_created',
  'constraints_resolved',
  'options_published',
  'option_selected',
  'option_rejected',
  'plan_published',
  'authority_requested',
  'authority_granted',
  'authority_revoked',
  'execution_started',
  'checkpoint_recorded',
  'handoff_requested',
  'handoff_resumed',
  'external_op_recorded',
  'artifact_recorded',
  'verification_recorded',
  'sync_updated',
  'monitor_updated',
  'failure_recorded',
  'state_changed',
]

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Event payload field "${field}" must be a non-empty string.`)
  return value
}

/** Validate + normalize one event payload at write time. Throws on anything malformed. */
export function parseEventInput(input: { type: string; payload: unknown }): TaskEventInput {
  if (!TASK_EVENT_TYPES.includes(input.type as TaskEventType)) {
    throw new Error(`Unknown task event type: ${input.type}`)
  }
  const type = input.type as TaskEventType
  const p = (input.payload ?? {}) as Record<string, unknown>
  switch (type) {
    case 'task_created':
      return { type, payload: { request: requireString(p.request, 'request'), persona: typeof p.persona === 'string' ? p.persona : 'friend', conversation_id: typeof p.conversation_id === 'string' ? p.conversation_id : null } }
    case 'constraints_resolved':
      if (typeof p.constraints !== 'object' || p.constraints === null) throw new Error('constraints must be an object.')
      return { type, payload: { constraints: p.constraints as Record<string, unknown> } }
    case 'options_published': {
      if (!Array.isArray(p.options)) throw new Error('options must be an array.')
      const options = p.options.map((raw) => {
        const o = (raw ?? {}) as Partial<TaskOption>
        return {
          ...o,
          id: requireString(o.id, 'options[].id'),
          title: requireString(o.title, 'options[].title'),
        } as TaskOption
      })
      return { type, payload: { options } }
    }
    case 'option_selected':
    case 'option_rejected':
      return { type, payload: { option_id: requireString(p.option_id, 'option_id'), ...(typeof p.reason === 'string' ? { reason: p.reason } : {}) } }
    case 'plan_published':
      if (typeof p.plan_version !== 'number' || !Number.isInteger(p.plan_version) || p.plan_version < 1) throw new Error('plan_version must be a positive integer.')
      return { type, payload: { plan_version: p.plan_version, plan: p.plan, ...(p.current_step !== undefined ? { current_step: p.current_step } : {}) } }
    case 'authority_requested':
    case 'authority_granted':
    case 'authority_revoked':
      return { type, payload: { grant_id: requireString(p.grant_id, 'grant_id') } }
    case 'execution_started':
      return { type, payload: { ...(typeof p.grant_id === 'string' ? { grant_id: p.grant_id } : {}), ...(p.checkout && typeof p.checkout === 'object' ? { checkout: p.checkout as Record<string, unknown> } : {}) } }
    case 'checkpoint_recorded':
      return { type, payload: { step: p.step } }
    case 'handoff_requested':
      return { type, payload: { kind: requireString(p.kind, 'kind'), ref: requireString(p.ref, 'ref') } }
    case 'handoff_resumed':
      return { type, payload: { kind: requireString(p.kind, 'kind') } }
    case 'external_op_recorded':
      return { type, payload: { operation: requireString(p.operation, 'operation'), idempotency_key: requireString(p.idempotency_key, 'idempotency_key'), status: requireString(p.status, 'status'), evidence_ref: typeof p.evidence_ref === 'string' ? p.evidence_ref : null } }
    case 'artifact_recorded':
      return { type, payload: { kind: requireString(p.kind, 'kind'), ref: typeof p.ref === 'string' ? p.ref : null, url: typeof p.url === 'string' ? p.url : null, at: typeof p.at === 'string' ? p.at : undefined } }
    case 'verification_recorded': {
      if (typeof p.passed !== 'boolean') throw new Error('verification.passed must be a boolean.')
      if (!Array.isArray(p.evidence)) throw new Error('verification.evidence must be an array of references.')
      return { type, payload: { passed: p.passed, evidence: p.evidence.map((e) => requireString(e, 'evidence[]')), ...(typeof p.at === 'string' ? { at: p.at } : {}) } }
    }
    case 'sync_updated':
      return { type, payload: { surface: requireString(p.surface, 'surface'), status: requireString(p.status, 'status'), ref: typeof p.ref === 'string' ? p.ref : null } }
    case 'monitor_updated': {
      if (!MONITOR_STATES.includes(p.state as MonitorState)) throw new Error(`Unknown monitor state: ${String(p.state)}`)
      return { type, payload: { state: p.state as MonitorState, ...(p.policy !== undefined ? { policy: p.policy } : {}), next_check_at: typeof p.next_check_at === 'string' ? p.next_check_at : null } }
    }
    case 'failure_recorded': {
      const code = requireString(p.reason_code, 'reason_code')
      if (!FAILURE_REASON_CODES.includes(code as FailureReasonCode)) throw new Error(`Unknown failure reason code: ${code}`)
      return { type, payload: { reason_code: code, ...(typeof p.detail === 'string' ? { detail: p.detail } : {}), ...(typeof p.at === 'string' ? { at: p.at } : {}) } }
    }
    case 'state_changed': {
      const to = requireString(p.to, 'to')
      if (!TASK_STATES.includes(to as TaskState)) throw new Error(`Unknown task state: ${to}`)
      return {
        type,
        payload: {
          to: to as TaskState,
          grant_id: typeof p.grant_id === 'string' ? p.grant_id : null,
          authority: p.authority === 'not_required' ? 'not_required' : null,
          reason_code: typeof p.reason_code === 'string' ? p.reason_code : null,
        },
      }
    }
  }
}

/* ---------------------------------------------------------------- reducer */

export function seedProjection(request: string, persona: string, conversationId: string | null): TaskProjection {
  return {
    request,
    persona,
    conversation_id: conversationId,
    constraints: {},
    state: 'DRAFT',
    resumed_state: null,
    monitor_state: 'OFF',
    monitor_policy: null,
    monitor_next_check_at: null,
    plan_version: 0,
    plan: null,
    current_step: null,
    options: [],
    selected_option_id: null,
    grants: [],
    external_ops: [],
    artifacts: [],
    verification: null,
    sync_state: {},
    failure: null,
  }
}

/**
 * Pure reducer: (projection, validated event) -> next projection. Throws only
 * on data-inconsistent writes (selecting a nonexistent option, unknown grant);
 * because validation happens at append time, replay of stored events cannot
 * throw on rows this code wrote, keeping rebuild deterministic.
 */
export function reduce(projection: TaskProjection, event: TaskEventInput): TaskProjection {
  switch (event.type) {
    case 'task_created':
      return projection
    case 'constraints_resolved': {
      const p = event.payload
      return { ...projection, constraints: { ...projection.constraints, ...p.constraints } }
    }
    case 'options_published': {
      const p = event.payload
      const byId = new Map(projection.options.map((o) => [o.id, o]))
      for (const option of p.options) {
        const existing = byId.get(option.id)
        byId.set(option.id, existing ? { ...existing, ...option } : option)
      }
      return { ...projection, options: [...byId.values()] }
    }
    case 'option_selected': {
      const p = event.payload
      if (!projection.options.some((o) => o.id === p.option_id)) {
        throw new Error(`Cannot select unknown option: ${p.option_id}`)
      }
      return { ...projection, selected_option_id: p.option_id }
    }
    case 'option_rejected': {
      const p = event.payload
      return {
        ...projection,
        options: projection.options.map((o) => (o.id === p.option_id ? { ...o, rejected: true } : o)),
        selected_option_id: projection.selected_option_id === p.option_id ? null : projection.selected_option_id,
      }
    }
    case 'plan_published': {
      const p = event.payload
      return { ...projection, plan_version: p.plan_version, plan: p.plan, ...(p.current_step !== undefined ? { current_step: p.current_step } : {}) }
    }
    case 'authority_requested':
      return { ...projection, grants: upsertGrant(projection.grants, event.payload.grant_id, 'requested') }
    case 'authority_granted': {
      const p = event.payload
      if (!projection.grants.some((g) => g.grant_id === p.grant_id)) throw new Error(`Cannot grant unknown capability: ${p.grant_id}`)
      return { ...projection, grants: upsertGrant(projection.grants, p.grant_id, 'granted') }
    }
    case 'authority_revoked':
      return { ...projection, grants: upsertGrant(projection.grants, event.payload.grant_id, 'revoked') }
    case 'execution_started': {
      const p = event.payload
      return {
        ...projection,
        current_step: { ...(asRecord(projection.current_step)), ...(p.checkout ? { checkout: p.checkout } : {}) },
      }
    }
    case 'checkpoint_recorded':
      return { ...projection, current_step: { ...(asRecord(projection.current_step)), step: event.payload.step } }
    case 'handoff_requested': {
      const p = event.payload
      return { ...projection, artifacts: [...projection.artifacts, { kind: `handoff:${p.kind}`, ref: p.ref }] }
    }
    case 'handoff_resumed':
      return { ...projection, artifacts: [...projection.artifacts, { kind: `handoff_resumed:${event.payload.kind}`, ref: null }] }
    case 'external_op_recorded': {
      const p = event.payload
      const exists = projection.external_ops.some(
        (op) => op.operation === p.operation && op.idempotency_key === p.idempotency_key,
      )
      if (exists) return projection
      return { ...projection, external_ops: [...projection.external_ops, p] }
    }
    case 'artifact_recorded':
      return { ...projection, artifacts: [...projection.artifacts, event.payload] }
    case 'verification_recorded':
      return { ...projection, verification: event.payload }
    case 'sync_updated': {
      const p = event.payload
      return { ...projection, sync_state: { ...projection.sync_state, [p.surface]: { status: p.status, ref: p.ref } } }
    }
    case 'monitor_updated': {
      const p = event.payload
      return {
        ...projection,
        monitor_state: p.state,
        ...(p.policy !== undefined ? { monitor_policy: p.policy } : {}),
        monitor_next_check_at: p.next_check_at ?? null,
      }
    }
    case 'failure_recorded':
      return { ...projection, failure: event.payload }
    case 'state_changed': {
      const p = event.payload
      const resumedFromPaused = projection.state === 'PAUSED_BY_USER' || projection.state === 'FAILED_RETRYABLE'
      let resumed_state = projection.resumed_state
      if (p.to === 'PAUSED_BY_USER' || p.to === 'FAILED_RETRYABLE') resumed_state = projection.state
      else if (resumedFromPaused) resumed_state = null
      return { ...projection, state: p.to, resumed_state }
    }
  }
}

function upsertGrant(grants: GrantRef[], grantId: string, status: GrantRef['status']): GrantRef[] {
  const exists = grants.some((g) => g.grant_id === grantId)
  return exists
    ? grants.map((g) => (g.grant_id === grantId ? { ...g, status } : g))
    : [...grants, { grant_id: grantId, status }]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/* ------------------------------------------------------- secret hygiene */

/**
 * Payloads store references to Vault or encrypted records, never raw secrets
 * (plan: "Sensitive payloads store references"). Exact key names are rejected;
 * values are never inspected (no regex doctrine).
 */
const SECRET_KEYS = new Set([
  'password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'authorization',
  'cookie', 'credential_value', 'credit_card', 'card_number', 'cvv', 'pin', 'otp',
  'totp', 'private_key', 'client_secret', 'access_token', 'refresh_token',
])

export function assertNoSecretKeys(payload: unknown, path = 'payload'): void {
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertNoSecretKeys(item, `${path}[${i}]`))
    return
  }
  if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      if (SECRET_KEYS.has(key.toLowerCase())) {
        throw new Error(`${path}.${key}: task events may store references only, never secret values.`)
      }
      assertNoSecretKeys(value, `${path}.${key}`)
    }
  }
}
