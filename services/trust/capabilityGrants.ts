import { createHash, randomUUID } from 'node:crypto'
import type { SQL } from 'bun'

export const CAPABILITY_RESOURCE_TYPES = ['credential', 'payment', 'memory', 'computer'] as const
export type CapabilityResourceType = (typeof CAPABILITY_RESOURCE_TYPES)[number]

export const CAPABILITY_STATUSES = [
  'proposed',
  'pending',
  'approved',
  'consuming',
  'consumed',
  'denied',
  'revoked',
  'expired',
  'needs_reconciliation',
] as const
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number]

export type CartLine = {
  sku?: string
  description: string
  quantity: number
  unitAmountCents: number
}

export type CapabilityRequest = {
  userId: string
  taskId: string
  resourceType: CapabilityResourceType
  resourceId?: string | null
  action: string
  exactOrigin?: string | null
  amountCents?: number | null
  currency?: string | null
  merchant?: string | null
  recipient?: string | null
  cart?: CartLine[] | null
  requestingAgent: string
  purpose: string
  expiresAt: Date | string
}

export type CanonicalCapabilityRequest = {
  schema_version: 1
  user_id: string
  task_id: string
  resource_type: CapabilityResourceType
  resource_id: string | null
  action: string
  exact_origin: string | null
  amount_cents: number | null
  currency: string | null
  merchant: string | null
  recipient: string | null
  cart: Array<{ sku: string | null; description: string; quantity: number; unit_amount_cents: number }>
  requesting_agent: string
  purpose: string
  expires_at: string
}

export type CapabilityGrantRow = {
  id: string
  user_id: string
  task_id: string
  resource_type: CapabilityResourceType
  resource_id: string | null
  action: string
  exact_origin: string | null
  amount_cents: number | null
  currency: string | null
  merchant: string | null
  recipient: string | null
  cart: CanonicalCapabilityRequest['cart']
  requesting_agent: string
  purpose: string
  request_digest: Uint8Array
  status: CapabilityStatus
  expires_at: Date
  revocation_requested_at: Date | null
}

const TERMINAL_STATUSES = new Set<CapabilityStatus>(['consumed', 'denied', 'revoked', 'expired'])

const ALLOWED_TRANSITIONS: Readonly<Record<CapabilityStatus, readonly CapabilityStatus[]>> = {
  proposed: ['pending', 'denied', 'revoked', 'expired'],
  pending: ['approved', 'denied', 'revoked', 'expired'],
  approved: ['consuming', 'revoked', 'expired'],
  consuming: ['consumed', 'revoked', 'needs_reconciliation'],
  consumed: [],
  denied: [],
  revoked: [],
  expired: [],
  needs_reconciliation: ['consumed', 'revoked'],
}

function requiredText(value: string, name: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required.`)
  if (normalized.length > maxLength) throw new Error(`${name} is too long.`)
  return normalized
}

export function normalizeExactOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Origin must be a valid HTTPS URL.')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Origin must use HTTPS and cannot contain credentials.')
  }
  return url.origin
}

function normalizeExpiry(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Capability expiry is invalid.')
  return date.toISOString()
}

function normalizeCart(cart: CartLine[] | null | undefined): CanonicalCapabilityRequest['cart'] {
  if (!cart) return []
  if (cart.length > 100) throw new Error('Cart cannot contain more than 100 lines.')
  return cart.map((line) => {
    const quantity = Number(line.quantity)
    const unitAmountCents = Number(line.unitAmountCents)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) throw new Error('Cart quantity is invalid.')
    if (!Number.isInteger(unitAmountCents) || unitAmountCents < 0) throw new Error('Cart amount is invalid.')
    return {
      sku: line.sku ? requiredText(line.sku, 'Cart SKU', 200) : null,
      description: requiredText(line.description, 'Cart description', 500),
      quantity,
      unit_amount_cents: unitAmountCents,
    }
  })
}

export function canonicalizeCapabilityRequest(input: CapabilityRequest): CanonicalCapabilityRequest {
  if (!CAPABILITY_RESOURCE_TYPES.includes(input.resourceType)) throw new Error('Capability resource type is invalid.')
  const amountCents = input.amountCents == null ? null : Number(input.amountCents)
  if (amountCents != null && (!Number.isInteger(amountCents) || amountCents < 1)) throw new Error('Payment amount must be positive integer cents.')
  const currency = input.currency ? input.currency.trim().toUpperCase() : null
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a three-letter code.')
  const cart = normalizeCart(input.cart)
  if (input.resourceType === 'payment') {
    if (amountCents == null || !currency || !input.merchant) throw new Error('Payment capabilities require amount, currency, and merchant.')
    const cartTotal = cart.reduce((sum, line) => sum + line.quantity * line.unit_amount_cents, 0)
    if (cart.length > 0 && cartTotal !== amountCents) throw new Error('Cart total must equal the approved payment amount.')
  } else if (amountCents != null || currency || input.merchant || input.recipient || cart.length > 0) {
    throw new Error('Payment scope is only valid for payment capabilities.')
  }

  return {
    schema_version: 1,
    user_id: requiredText(input.userId, 'User ID', 200),
    task_id: requiredText(input.taskId, 'Task ID', 200),
    resource_type: input.resourceType,
    resource_id: input.resourceId ? requiredText(input.resourceId, 'Resource ID', 200) : null,
    action: requiredText(input.action, 'Action', 100),
    exact_origin: input.exactOrigin ? normalizeExactOrigin(input.exactOrigin) : null,
    amount_cents: amountCents,
    currency,
    merchant: input.merchant ? requiredText(input.merchant, 'Merchant', 200) : null,
    recipient: input.recipient ? requiredText(input.recipient, 'Recipient', 300) : null,
    cart,
    requesting_agent: requiredText(input.requestingAgent, 'Requesting agent', 200),
    purpose: requiredText(input.purpose, 'Purpose', 500),
    expires_at: normalizeExpiry(input.expiresAt),
  }
}

/** JSON.stringify is deterministic here because the canonical object and every nested line
 * are constructed above in a fixed key order. Never digest the caller's input object. */
export function capabilityRequestDigest(input: CapabilityRequest | CanonicalCapabilityRequest): string {
  const canonical = 'schema_version' in input ? input : canonicalizeCapabilityRequest(input)
  const fixedOrder = {
    schema_version: canonical.schema_version,
    user_id: canonical.user_id,
    task_id: canonical.task_id,
    resource_type: canonical.resource_type,
    resource_id: canonical.resource_id,
    action: canonical.action,
    exact_origin: canonical.exact_origin,
    amount_cents: canonical.amount_cents,
    currency: canonical.currency,
    merchant: canonical.merchant,
    recipient: canonical.recipient,
    cart: canonical.cart.map((line) => ({
      sku: line.sku,
      description: line.description,
      quantity: line.quantity,
      unit_amount_cents: line.unit_amount_cents,
    })),
    requesting_agent: canonical.requesting_agent,
    purpose: canonical.purpose,
    expires_at: canonical.expires_at,
  }
  return createHash('sha256').update(JSON.stringify(fixedOrder), 'utf8').digest('hex')
}

function digestBytes(digest: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Capability digest must be lowercase SHA-256 hex.')
  return Buffer.from(digest, 'hex')
}

export function canTransitionCapability(from: CapabilityStatus, to: CapabilityStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function isTerminalCapabilityStatus(status: CapabilityStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export async function createCapabilityGrant(
  sql: SQL,
  input: CapabilityRequest,
): Promise<{ id: string; digest: string; request: CanonicalCapabilityRequest }> {
  const request = canonicalizeCapabilityRequest(input)
  const digest = capabilityRequestDigest(request)
  const id = randomUUID()
  await sql`
    INSERT INTO capability_grants (
      id, user_id, task_id, resource_type, resource_id, action, exact_origin,
      amount_cents, currency, merchant, recipient, cart, requesting_agent,
      purpose, request_digest, status, expires_at
    ) VALUES (
      ${id}, ${request.user_id}, ${request.task_id}, ${request.resource_type}, ${request.resource_id},
      ${request.action}, ${request.exact_origin}, ${request.amount_cents}, ${request.currency},
      ${request.merchant}, ${request.recipient}, ${JSON.stringify(request.cart)}::jsonb,
      ${request.requesting_agent}, ${request.purpose}, ${Buffer.from(digest, 'hex')}, 'pending', ${request.expires_at}
    )
  `
  return { id, digest, request }
}

export async function decideCapabilityGrant(
  sql: SQL,
  input: { id: string; userId: string; taskId: string; digest: string; decision: 'approved' | 'denied' },
): Promise<boolean> {
  const rows = (await sql`
    UPDATE capability_grants
    SET status = ${input.decision}, decided_at = now(),
        approved_at = CASE WHEN ${input.decision} = 'approved' THEN now() ELSE approved_at END
    WHERE id = ${input.id} AND user_id = ${input.userId} AND task_id = ${input.taskId}
      AND request_digest = ${digestBytes(input.digest)}
      AND status = 'pending' AND expires_at > now()
    RETURNING id
  `) as Array<{ id: string }>
  return rows.length === 1
}

/** Atomically claims an approved grant. Every immutable scope field is fenced by the digest. */
export async function beginCapabilityConsumption(
  sql: SQL,
  input: { id: string; userId: string; taskId: string; digest: string },
): Promise<CapabilityGrantRow | null> {
  const rows = (await sql`
    UPDATE capability_grants
    SET status = 'consuming', consuming_at = now()
    WHERE id = ${input.id} AND user_id = ${input.userId} AND task_id = ${input.taskId}
      AND request_digest = ${digestBytes(input.digest)}
      AND status = 'approved' AND expires_at > now() AND revocation_requested_at IS NULL
    RETURNING id, user_id, task_id, resource_type, resource_id, action, exact_origin,
      amount_cents, currency, merchant, recipient, cart, requesting_agent, purpose,
      request_digest, status, expires_at, revocation_requested_at
  `) as CapabilityGrantRow[]
  return rows[0] ?? null
}

export async function requestCapabilityRevocation(
  sql: SQL,
  input: { id: string; userId: string; taskId: string },
): Promise<'revoked' | 'cancellation_requested' | 'unavailable'> {
  const rows = (await sql`
    UPDATE capability_grants
    SET revocation_requested_at = now(),
        status = CASE WHEN status = 'consuming' THEN status ELSE 'revoked' END,
        revoked_at = CASE WHEN status = 'consuming' THEN revoked_at ELSE now() END
    WHERE id = ${input.id} AND user_id = ${input.userId} AND task_id = ${input.taskId}
      AND status IN ('proposed', 'pending', 'approved', 'consuming')
    RETURNING status
  `) as Array<{ status: CapabilityStatus }>
  if (!rows[0]) return 'unavailable'
  return rows[0].status === 'consuming' ? 'cancellation_requested' : 'revoked'
}

export async function finalizeCapabilityConsumption(
  sql: SQL,
  input: {
    id: string
    userId: string
    taskId: string
    outcome: 'completed' | 'cancelled_before_side_effect' | 'unknown'
    providerReference?: string | null
  },
): Promise<CapabilityStatus | null> {
  const nextStatus: CapabilityStatus = input.outcome === 'completed'
    ? 'consumed'
    : input.outcome === 'unknown' ? 'needs_reconciliation' : 'revoked'
  const rows = (await sql`
    UPDATE capability_grants
    SET status = ${nextStatus},
        consumed_at = CASE WHEN ${nextStatus} = 'consumed' THEN now() ELSE consumed_at END,
        revoked_at = CASE WHEN ${nextStatus} = 'revoked' THEN now() ELSE revoked_at END,
        provider_reference = ${input.providerReference ?? null}, finalized_at = now()
    WHERE id = ${input.id} AND user_id = ${input.userId} AND task_id = ${input.taskId}
      AND status = 'consuming'
    RETURNING status
  `) as Array<{ status: CapabilityStatus }>
  return rows[0]?.status ?? null
}

export async function expireCapabilityGrants(sql: SQL, limit = 500): Promise<number> {
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)))
  const rows = (await sql`
    WITH expired AS (
      SELECT id FROM capability_grants
      WHERE status IN ('proposed', 'pending', 'approved') AND expires_at <= now()
      ORDER BY expires_at ASC LIMIT ${safeLimit} FOR UPDATE SKIP LOCKED
    )
    UPDATE capability_grants g SET status = 'expired', finalized_at = now()
    FROM expired WHERE g.id = expired.id RETURNING g.id
  `) as Array<{ id: string }>
  return rows.length
}
