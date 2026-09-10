import { createHash, randomUUID } from 'node:crypto'
import type { SQL } from 'bun'

const SAFE_METADATA_KEYS = new Set([
  'origin', 'amount_cents', 'currency', 'merchant', 'recipient', 'category',
  'retention_days', 'provider', 'status', 'reason', 'item_label',
  'environment_id', 'expires_at',
])
const FORBIDDEN_KEY = /(secret|password|credential|token|cookie|authorization|auth_document|card_number|cvc)/i

export type AuditEventInput = {
  userId: string
  taskId?: string | null
  capabilityGrantId?: string | null
  eventType: string
  resourceType?: 'credential' | 'payment' | 'memory' | 'computer' | null
  outcome: string
  safeMetadata?: Record<string, unknown>
  occurredAt?: Date
}

export type AuditEventView = {
  sequence: number
  id: string
  task_id: string | null
  capability_grant_id: string | null
  event_type: string
  resource_type: string | null
  outcome: string
  safe_metadata: Record<string, unknown>
  occurred_at: Date
}

function required(value: string, name: string, max = 120): string {
  const result = value.trim()
  if (!result || result.length > max) throw new Error(`${name} is invalid.`)
  return result
}

export function sanitizeAuditMetadata(input: Record<string, unknown> = {}): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {}
  for (const key of Object.keys(input).sort()) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`Sensitive audit metadata key is forbidden: ${key}.`)
    if (!SAFE_METADATA_KEYS.has(key)) continue
    const value = input[key]
    if (value === null || typeof value === 'boolean') output[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value
    else if (typeof value === 'string') output[key] = value.slice(0, 500)
  }
  return output
}

type HashableEvent = {
  id: string
  user_id: string
  task_id: string | null
  capability_grant_id: string | null
  event_type: string
  resource_type: string | null
  outcome: string
  safe_metadata: Record<string, unknown>
  occurred_at: string
}

function eventHash(previousHash: Buffer | null, event: HashableEvent): Buffer {
  return createHash('sha256')
    .update(previousHash ?? Buffer.alloc(0))
    .update(JSON.stringify(event), 'utf8')
    .digest()
}

export async function appendAuditEvent(sql: SQL, input: AuditEventInput): Promise<{ id: string; hash: string }> {
  const id = randomUUID()
  const occurredAt = input.occurredAt ?? new Date()
  if (!Number.isFinite(occurredAt.getTime())) throw new Error('Audit timestamp is invalid.')
  const event: HashableEvent = {
    id,
    user_id: required(input.userId, 'Audit user', 200),
    task_id: input.taskId ? required(input.taskId, 'Audit task', 200) : null,
    capability_grant_id: input.capabilityGrantId ?? null,
    event_type: required(input.eventType, 'Audit event type'),
    resource_type: input.resourceType ?? null,
    outcome: required(input.outcome, 'Audit outcome'),
    safe_metadata: sanitizeAuditMetadata(input.safeMetadata),
    occurred_at: occurredAt.toISOString(),
  }
  let result: { id: string; hash: string } | null = null
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${event.user_id}, 0))`
    const prior = (await tx`
      SELECT event_hash FROM audit_events WHERE user_id = ${event.user_id}
      ORDER BY sequence DESC LIMIT 1
    `) as Array<{ event_hash: Uint8Array }>
    const previousHash = prior[0] ? Buffer.from(prior[0].event_hash) : null
    const hash = eventHash(previousHash, event)
    await tx`
      INSERT INTO audit_events (
        id, user_id, task_id, capability_grant_id, event_type, resource_type,
        outcome, safe_metadata, previous_hash, event_hash, occurred_at
      ) VALUES (
        ${event.id}, ${event.user_id}, ${event.task_id}, ${event.capability_grant_id}, ${event.event_type},
        ${event.resource_type}, ${event.outcome}, ${JSON.stringify(event.safe_metadata)}::jsonb,
        ${previousHash}, ${hash}, ${event.occurred_at}
      )
    `
    result = { id, hash: hash.toString('hex') }
  })
  if (!result) throw new Error('Audit transaction did not complete.')
  return result
}

export async function listAuditEvents(sql: SQL, userId: string, limit = 100): Promise<AuditEventView[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  return (await sql`
    SELECT sequence, id, task_id, capability_grant_id, event_type, resource_type,
      outcome, safe_metadata, occurred_at
    FROM audit_events WHERE user_id = ${userId}
    ORDER BY sequence DESC LIMIT ${safeLimit}
  `) as AuditEventView[]
}

export async function verifyAuditChain(sql: SQL, userId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT id, user_id, task_id, capability_grant_id, event_type, resource_type,
      outcome, safe_metadata, previous_hash, event_hash, occurred_at
    FROM audit_events WHERE user_id = ${userId} ORDER BY sequence ASC
  `) as Array<HashableEvent & { previous_hash: Uint8Array | null; event_hash: Uint8Array; occurred_at: Date | string }>
  let previous: Buffer | null = null
  for (const row of rows) {
    const storedPrevious = row.previous_hash ? Buffer.from(row.previous_hash) : null
    if (!(storedPrevious?.equals(previous ?? Buffer.alloc(0)) ?? previous === null)) return false
    const hashable: HashableEvent = {
      id: row.id, user_id: row.user_id, task_id: row.task_id,
      capability_grant_id: row.capability_grant_id, event_type: row.event_type,
      resource_type: row.resource_type, outcome: row.outcome,
      safe_metadata: sanitizeAuditMetadata(row.safe_metadata),
      occurred_at: new Date(row.occurred_at).toISOString(),
    }
    const expected = eventHash(previous, hashable)
    if (!expected.equals(Buffer.from(row.event_hash))) return false
    previous = expected
  }
  return true
}
