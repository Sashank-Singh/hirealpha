import type { SQL } from 'bun'
import { appendAuditEvent, listAuditEvents } from './auditLedger'
import { decideCapabilityGrant, requestCapabilityRevocation } from './capabilityGrants'
import {
  deleteUserMemories,
  exportUserMemories,
  grantMemoryConsent,
  revokeMemoryConsent,
} from './memoryLifecycle'
import type { UserKeyBroker } from './userKeyBroker'
import type { MemoryIndex } from './memoryIndex'
import { listVaultItems, revokeVaultItem, saveVaultItem } from './vaultV2'
import { purgeAccountTrustData } from './memoryLifecycle'

type TrustApiDeps = {
  resolveUser: (sql: SQL, request: Request) => Promise<{ id: string } | null>
  keyBroker?: UserKeyBroker | null
  /** The derived retrieval index. Optional: without it deletions still shred
   * the authoritative rows, and the index is rebuilt by the backfill. */
  memoryIndex?: MemoryIndex | null
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

export async function handleTrustApi(request: Request, sql: SQL, deps: TrustApiDeps): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/trust/')) return null
  const user = await deps.resolveUser(sql, request)
  if (!user) return json({ error: 'Sign in first.' }, 401)

  if (url.pathname === '/api/trust/overview' && request.method === 'GET') {
    const capabilities = (await sql`
      SELECT id, task_id, resource_type, resource_id, action, exact_origin, amount_cents,
        currency, merchant, recipient, requesting_agent, purpose, encode(request_digest, 'hex') AS digest,
        status, expires_at, created_at
      FROM capability_grants WHERE user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 100
    `) as Array<Record<string, unknown>>
    return json({ capabilities, audit: await listAuditEvents(sql, user.id, 100) })
  }

  const decisionMatch = url.pathname.match(/^\/api\/trust\/capabilities\/([^/]+)\/decision$/)
  if (decisionMatch && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { digest?: string; decision?: string }
    if (!/^[a-f0-9]{64}$/.test(body.digest ?? '') || !['approved', 'denied'].includes(body.decision ?? '')) {
      return json({ error: 'A valid digest and decision are required.' }, 400)
    }
    const rows = (await sql`
      SELECT task_id, resource_type, exact_origin, amount_cents, currency, merchant
      FROM capability_grants WHERE id = ${decisionMatch[1]!} AND user_id = ${user.id} LIMIT 1
    `) as Array<{
      task_id: string; resource_type: 'credential' | 'payment' | 'memory' | 'computer'; exact_origin: string | null
      amount_cents: number | null; currency: string | null; merchant: string | null
    }>
    if (!rows[0]) return json({ error: 'Capability not found.' }, 404)
    const decided = await decideCapabilityGrant(sql, {
      id: decisionMatch[1]!, userId: user.id, taskId: rows[0].task_id,
      digest: body.digest!, decision: body.decision as 'approved' | 'denied',
    })
    if (!decided) return json({ error: 'Capability is no longer pending.' }, 409)
    await appendAuditEvent(sql, {
      userId: user.id, taskId: rows[0].task_id, capabilityGrantId: decisionMatch[1]!,
      eventType: 'capability.decided', resourceType: rows[0].resource_type, outcome: body.decision!,
      safeMetadata: {
        origin: rows[0].exact_origin, amount_cents: rows[0].amount_cents,
        currency: rows[0].currency, merchant: rows[0].merchant,
      },
    })
    return json({ ok: true })
  }

  if (url.pathname === '/api/trust/memory/consent' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { category?: string; purpose?: string; expiresAt?: string; consentVersion?: number; source?: string }
    try {
      const id = await grantMemoryConsent(sql, {
        userId: user.id, category: body.category ?? '', purpose: body.purpose ?? '',
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        consentVersion: Number(body.consentVersion) || 1,
        source: body.source,
      })
      await appendAuditEvent(sql, {
        userId: user.id, eventType: 'memory.consent_granted', resourceType: 'memory', outcome: 'granted',
        safeMetadata: { category: body.category ?? '', expires_at: body.expiresAt ?? null },
      })
      return json({ ok: true, id })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Could not grant consent.' }, 400)
    }
  }

  if (url.pathname === '/api/trust/memory/consent' && request.method === 'DELETE') {
    const id = url.searchParams.get('id') ?? ''
    const revoked = await revokeMemoryConsent(sql, { userId: user.id, consentId: id })
    return revoked ? json({ ok: true }) : json({ error: 'Active consent not found.' }, 404)
  }

  if (url.pathname === '/api/trust/memory/export' && request.method === 'GET') {
    if (!deps.keyBroker) return json({ error: 'Memory encryption is not configured.' }, 503)
    const memories = await exportUserMemories(sql, deps.keyBroker, user.id)
    return new Response(JSON.stringify({ exported_at: new Date().toISOString(), memories }), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="hirealpha-memory-export.json"',
        'cache-control': 'no-store',
      },
    })
  }

  if (url.pathname === '/api/trust/memory' && request.method === 'DELETE') {
    const body = (await request.json().catch(() => ({}))) as { category?: string }
    try {
      const deleted = await deleteUserMemories(sql, {
        userId: user.id, category: body.category, reason: 'user_request',
        index: deps.memoryIndex ?? null,
      })
      await appendAuditEvent(sql, {
        userId: user.id, eventType: 'memory.deleted', resourceType: 'memory', outcome: 'completed',
        safeMetadata: { category: body.category ?? null },
      })
      return json({ ok: true, deleted })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Could not delete memory.' }, 400)
    }
  }

  if (url.pathname === '/api/trust/vault' && request.method === 'GET') {
    // Masked metadata only: no ciphertext leaves the server, and usernames
    // are pre-masked hints (pe•••@example.com) from the vault layer.
    return json({ items: await listVaultItems(sql, user.id) })
  }

  if (url.pathname === '/api/trust/vault' && request.method === 'POST') {
    if (!deps.keyBroker) return json({ error: 'Vault encryption is not configured.' }, 503)
    const body = (await request.json().catch(() => ({}))) as {
      origin?: string; label?: string; username?: string; password?: string
    }
    try {
      const itemId = await saveVaultItem(sql, deps.keyBroker, {
        userId: user.id,
        origin: body.origin ?? '',
        label: body.label ?? '',
        username: body.username,
        password: body.password ?? '',
      })
      await appendAuditEvent(sql, {
        userId: user.id, eventType: 'vault.saved', resourceType: 'credential',
        outcome: 'saved', safeMetadata: { origin: body.origin ?? '' },
      })
      return json({ ok: true, id: itemId })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Could not save the credential.' }, 400)
    }
  }

  if (url.pathname === '/api/trust/vault' && request.method === 'DELETE') {
    const id = url.searchParams.get('id') ?? ''
    const revoked = await revokeVaultItem(sql, { userId: user.id, itemId: id })
    if (!revoked) return json({ error: 'Vault item not found.' }, 404)
    await appendAuditEvent(sql, {
      userId: user.id, eventType: 'vault.revoked', resourceType: 'credential',
      outcome: 'revoked', safeMetadata: {},
    })
    return json({ ok: true })
  }

  const revokeMatch = url.pathname.match(/^\/api\/trust\/capabilities\/([^/]+)$/)
  if (revokeMatch && request.method === 'DELETE') {
    const rows = (await sql`
      SELECT task_id FROM capability_grants WHERE id = ${revokeMatch[1]!} AND user_id = ${user.id} LIMIT 1
    `) as Array<{ task_id: string }>
    if (!rows[0]) return json({ error: 'Capability not found.' }, 404)
    const result = await requestCapabilityRevocation(sql, {
      id: revokeMatch[1]!, userId: user.id, taskId: rows[0].task_id,
    })
    if (result === 'unavailable') return json({ error: 'Capability is not revocable.' }, 409)
    await appendAuditEvent(sql, {
      userId: user.id, taskId: rows[0].task_id, capabilityGrantId: revokeMatch[1]!,
      eventType: 'capability.revoked', resourceType: null, outcome: result,
      safeMetadata: {},
    })
    return json({ ok: true, result })
  }

  if (url.pathname === '/api/trust/account' && request.method === 'DELETE') {
    // Irreversible trust-data purge for account deletion: memory + bot memory,
    // consents, vault items, outstanding capabilities, and the user data key.
    const deleted = await purgeAccountTrustData(sql, user.id, deps.memoryIndex ?? null)
    await appendAuditEvent(sql, {
      userId: user.id, eventType: 'account.trust_data_purged', resourceType: null,
      outcome: 'completed', safeMetadata: {},
    })
    return json({ ok: true, deleted })
  }

  return json({ error: 'Not found.' }, 404)
}
