import { randomUUID } from 'node:crypto'
import type { SQL } from 'bun'
import { beginCapabilityConsumption, finalizeCapabilityConsumption, normalizeExactOrigin } from './capabilityGrants'
import { decryptUserPayload, encryptUserPayload, loadOrCreateUserKey, type UserKeyBroker } from './userKeyBroker'

export type VaultItemView = {
  id: string
  exact_origin: string
  label: string
  username_hint: string | null
  created_at: Date
  updated_at: Date
}

function cleanLabel(value: string): string {
  const label = value.trim()
  if (!label || label.length > 120) throw new Error('Vault item label is invalid.')
  return label
}

function cleanCredential(input: { username?: string; password: string }): { username: string; password: string } {
  const username = (input.username ?? '').trim()
  if (username.length > 320) throw new Error('Username is too long.')
  if (typeof input.password !== 'string' || input.password.length < 4 || input.password.length > 2_000) {
    throw new Error('Password is invalid.')
  }
  return { username, password: input.password }
}

function hint(username: string): string | null {
  if (!username) return null
  if (username.includes('@')) {
    const [local, domain] = username.split('@', 2)
    return `${local!.slice(0, 2)}•••@${domain}`
  }
  return `${username.slice(0, 2)}${'•'.repeat(Math.min(6, Math.max(2, username.length - 2)))}`
}

async function encryptForItem(
  sql: SQL,
  broker: UserKeyBroker,
  input: { userId: string; itemId: string; exactOrigin: string; credential: { username: string; password: string } },
): Promise<string> {
  const key = await loadOrCreateUserKey(sql, broker, input.userId)
  try {
    return encryptUserPayload(JSON.stringify(input.credential), key, {
      userId: input.userId,
      recordId: input.itemId,
      scope: `vault:${input.exactOrigin}`,
    })
  } finally {
    key.fill(0)
  }
}

export async function saveVaultItem(
  sql: SQL,
  broker: UserKeyBroker,
  input: { userId: string; origin: string; label: string; username?: string; password: string },
): Promise<string> {
  const exactOrigin = normalizeExactOrigin(input.origin)
  const label = cleanLabel(input.label)
  const credential = cleanCredential(input)
  const existing = (await sql`
    SELECT id FROM vault_items_v2
    WHERE user_id = ${input.userId} AND exact_origin = ${exactOrigin} AND label = ${label}
    LIMIT 1
  `) as Array<{ id: string }>
  const itemId = existing[0]?.id ?? randomUUID()
  const ciphertext = await encryptForItem(sql, broker, { userId: input.userId, itemId, exactOrigin, credential })

  if (existing[0]) {
    await sql`
      UPDATE vault_items_v2 SET ciphertext = ${ciphertext}, username_hint = ${hint(credential.username)},
        encryption_version = 1, revoked_at = NULL, updated_at = now()
      WHERE id = ${itemId} AND user_id = ${input.userId}
    `
    return itemId
  }

  const inserted = (await sql`
    INSERT INTO vault_items_v2 (id, user_id, exact_origin, label, username_hint, ciphertext, encryption_version)
    VALUES (${itemId}, ${input.userId}, ${exactOrigin}, ${label}, ${hint(credential.username)}, ${ciphertext}, 1)
    ON CONFLICT (user_id, exact_origin, label) DO NOTHING RETURNING id
  `) as Array<{ id: string }>
  if (inserted[0]) return itemId

  const winner = (await sql`
    SELECT id FROM vault_items_v2
    WHERE user_id = ${input.userId} AND exact_origin = ${exactOrigin} AND label = ${label}
    LIMIT 1
  `) as Array<{ id: string }>
  if (!winner[0]) throw new Error('Vault item was concurrently removed.')
  const winnerCiphertext = await encryptForItem(sql, broker, {
    userId: input.userId, itemId: winner[0].id, exactOrigin, credential,
  })
  await sql`
    UPDATE vault_items_v2 SET ciphertext = ${winnerCiphertext}, username_hint = ${hint(credential.username)},
      encryption_version = 1, revoked_at = NULL, updated_at = now()
    WHERE id = ${winner[0].id} AND user_id = ${input.userId}
  `
  return winner[0].id
}

export async function listVaultItems(sql: SQL, userId: string): Promise<VaultItemView[]> {
  return (await sql`
    SELECT id, exact_origin, label, username_hint, created_at, updated_at
    FROM vault_items_v2 WHERE user_id = ${userId} AND revoked_at IS NULL
    ORDER BY updated_at DESC
  `) as VaultItemView[]
}

export async function revokeVaultItem(sql: SQL, input: { userId: string; itemId: string }): Promise<boolean> {
  const rows = (await sql`
    UPDATE vault_items_v2 SET ciphertext = NULL, username_hint = NULL, revoked_at = now(), updated_at = now()
    WHERE id = ${input.itemId} AND user_id = ${input.userId} AND revoked_at IS NULL RETURNING id
  `) as Array<{ id: string }>
  return rows.length === 1
}

/**
 * Decrypts only after atomically claiming a matching one-time capability.
 * The grant is finalized before plaintext leaves this function, so it cannot
 * be reused even if the browser task fails later.
 */
export async function consumeVaultCredential(
  sql: SQL,
  broker: UserKeyBroker,
  input: { userId: string; taskId: string; itemId: string; capabilityId: string; digest: string; origin: string },
): Promise<{ username: string; password: string } | null> {
  const exactOrigin = normalizeExactOrigin(input.origin)
  const grant = await beginCapabilityConsumption(sql, {
    id: input.capabilityId, userId: input.userId, taskId: input.taskId, digest: input.digest,
  })
  if (!grant) return null
  if (grant.resource_type !== 'credential' || grant.resource_id !== input.itemId
    || grant.action !== 'autofill' || grant.exact_origin !== exactOrigin) {
    await finalizeCapabilityConsumption(sql, {
      id: input.capabilityId, userId: input.userId, taskId: input.taskId, outcome: 'cancelled_before_side_effect',
    })
    return null
  }

  const rows = (await sql`
    SELECT id, exact_origin, ciphertext FROM vault_items_v2
    WHERE id = ${input.itemId} AND user_id = ${input.userId} AND exact_origin = ${exactOrigin}
      AND revoked_at IS NULL AND ciphertext IS NOT NULL LIMIT 1
  `) as Array<{ id: string; exact_origin: string; ciphertext: string }>
  if (!rows[0]) {
    await finalizeCapabilityConsumption(sql, {
      id: input.capabilityId, userId: input.userId, taskId: input.taskId, outcome: 'cancelled_before_side_effect',
    })
    return null
  }

  const key = await loadOrCreateUserKey(sql, broker, input.userId)
  try {
    const plaintext = decryptUserPayload(rows[0].ciphertext, key, {
      userId: input.userId, recordId: rows[0].id, scope: `vault:${rows[0].exact_origin}`,
    })
    if (!plaintext) {
      await finalizeCapabilityConsumption(sql, {
        id: input.capabilityId, userId: input.userId, taskId: input.taskId, outcome: 'cancelled_before_side_effect',
      })
      return null
    }
    let credential: { username?: unknown; password?: unknown }
    try {
      credential = JSON.parse(plaintext) as { username?: unknown; password?: unknown }
    } catch {
      credential = {}
    }
    if (typeof credential.username !== 'string' || typeof credential.password !== 'string') {
      await finalizeCapabilityConsumption(sql, {
        id: input.capabilityId, userId: input.userId, taskId: input.taskId, outcome: 'cancelled_before_side_effect',
      })
      return null
    }
    await finalizeCapabilityConsumption(sql, {
      id: input.capabilityId, userId: input.userId, taskId: input.taskId, outcome: 'completed',
    })
    return { username: credential.username, password: credential.password }
  } finally {
    key.fill(0)
  }
}
