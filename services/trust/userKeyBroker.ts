import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SQL } from 'bun'

export type WrappedDataKey = { plaintext: Buffer; wrapped: string }

export type UserKeyBroker = {
  generate(userId: string): Promise<WrappedDataKey>
  unwrap(userId: string, wrapped: string): Promise<Buffer>
}

type OpenBaoResponse = { data?: { plaintext?: string; ciphertext?: string }; errors?: string[] }

export class OpenBaoTransitClient implements UserKeyBroker {
  private readonly baseUrl: URL

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly mount = 'transit',
    private readonly keyName = 'hirealpha-user-deks',
    private readonly namespace?: string,
  ) {
    this.baseUrl = new URL(baseUrl)
    if (this.baseUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(this.baseUrl.hostname)) {
      throw new Error('OpenBao must use HTTPS outside local development.')
    }
    if (!token.trim()) throw new Error('OPENBAO_TOKEN is required.')
    if (!/^[a-zA-Z0-9_-]+$/.test(mount) || !/^[a-zA-Z0-9_-]+$/.test(keyName)) throw new Error('OpenBao mount or key name is invalid.')
  }

  private async post(path: string, body: Record<string, unknown>): Promise<OpenBaoResponse> {
    const url = new URL(`/v1/${this.mount}/${path}`, this.baseUrl)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vault-token': this.token,
        ...(this.namespace ? { 'x-vault-namespace': this.namespace } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await response.json().catch(() => ({}))) as OpenBaoResponse
    if (!response.ok) throw new Error(`OpenBao request failed (${response.status}).`)
    return data
  }

  async generate(userId: string): Promise<WrappedDataKey> {
    const response = await this.post(`datakey/plaintext/${this.keyName}`, {
      bits: 256,
      associated_data: Buffer.from(`hirealpha:user:${userId}`).toString('base64'),
    })
    const plaintext = response.data?.plaintext
    const wrapped = response.data?.ciphertext
    if (!plaintext || !wrapped?.startsWith('vault:v')) throw new Error('OpenBao returned an invalid data key.')
    const key = Buffer.from(plaintext, 'base64')
    if (key.length !== 32) throw new Error('OpenBao data key was not 256 bits.')
    return { plaintext: key, wrapped }
  }

  async unwrap(userId: string, wrapped: string): Promise<Buffer> {
    const response = await this.post(`decrypt/${this.keyName}`, {
      ciphertext: wrapped,
      associated_data: Buffer.from(`hirealpha:user:${userId}`).toString('base64'),
    })
    const plaintext = response.data?.plaintext
    if (!plaintext) throw new Error('OpenBao could not unwrap the user key.')
    const key = Buffer.from(plaintext, 'base64')
    if (key.length !== 32) throw new Error('OpenBao returned an invalid user key.')
    return key
  }
}

export function openBaoBrokerFromEnv(env: NodeJS.ProcessEnv = process.env): OpenBaoTransitClient | null {
  const address = env.OPENBAO_ADDR?.trim()
  const token = env.OPENBAO_TOKEN?.trim()
  if (!address || !token) return null
  return new OpenBaoTransitClient(
    address,
    token,
    env.OPENBAO_TRANSIT_MOUNT?.trim() || 'transit',
    env.OPENBAO_TRANSIT_KEY?.trim() || 'hirealpha-user-deks',
    env.OPENBAO_NAMESPACE?.trim() || undefined,
  )
}

export type EncryptionContext = { userId: string; recordId: string; scope: string; version?: number }

function aad(context: EncryptionContext): Buffer {
  return Buffer.from(JSON.stringify({
    schema_version: 1,
    user_id: context.userId,
    record_id: context.recordId,
    scope: context.scope,
    encryption_version: context.version ?? 1,
  }))
}

export function encryptUserPayload(plaintext: string, key: Buffer, context: EncryptionContext): string {
  if (key.length !== 32) throw new Error('User data key must be 256 bits.')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptUserPayload(payload: string, key: Buffer, context: EncryptionContext): string | null {
  if (key.length !== 32) return null
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== 'v2') return null
  try {
    const iv = Buffer.from(parts[1]!, 'base64url')
    const tag = Buffer.from(parts[2]!, 'base64url')
    const ciphertext = Buffer.from(parts[3]!, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) return null
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aad(context))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export async function loadOrCreateUserKey(sql: SQL, broker: UserKeyBroker, userId: string): Promise<Buffer> {
  const rows = (await sql`
    SELECT wrapped_dek FROM user_wrapped_keys WHERE user_id = ${userId} AND destroyed_at IS NULL LIMIT 1
  `) as Array<{ wrapped_dek: string }>
  if (rows[0]) return broker.unwrap(userId, rows[0].wrapped_dek)

  const generated = await broker.generate(userId)
  try {
    const inserted = (await sql`
      INSERT INTO user_wrapped_keys (user_id, wrapped_dek, key_version)
      VALUES (${userId}, ${generated.wrapped}, 1)
      ON CONFLICT (user_id) DO NOTHING RETURNING user_id
    `) as Array<{ user_id: string }>
    if (inserted.length) return Buffer.from(generated.plaintext)
    const winner = (await sql`
      SELECT wrapped_dek FROM user_wrapped_keys WHERE user_id = ${userId} AND destroyed_at IS NULL LIMIT 1
    `) as Array<{ wrapped_dek: string }>
    if (!winner[0]) throw new Error('User key was concurrently destroyed.')
    return broker.unwrap(userId, winner[0].wrapped_dek)
  } finally {
    generated.plaintext.fill(0)
  }
}

export async function destroyUserKey(sql: SQL, userId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE user_wrapped_keys SET wrapped_dek = NULL, destroyed_at = now()
    WHERE user_id = ${userId} AND destroyed_at IS NULL RETURNING user_id
  `) as Array<{ user_id: string }>
  return rows.length === 1
}
