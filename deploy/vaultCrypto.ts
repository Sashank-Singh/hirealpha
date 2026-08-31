/**
 * Credential-vault encryption: AES-256-GCM, one fresh 12-byte IV per secret.
 *
 * The master key never ships in code — it comes from `HIREALPHA_VAULT_KEY` on
 * the server (any long passphrase; it is stretched through SHA-256 into a
 * 32-byte key, so key rotation means re-encrypting rows, which the vault list
 * endpoint flags). Ciphertext format: `v1.<iv>.<tag>.<ct>`, all base64url, so
 * a row is self-describing and versioned for future format migrations.
 *
 * GCM gives us tamper detection for free: any flipped bit in the ciphertext or
 * tag fails the auth check and decrypt returns null, never garbage.
 */
import { createHash, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto'

export type VaultKey = Buffer

/** Stretch a server-side passphrase into a 32-byte AES key. */
export function deriveVaultKey(secret: string): VaultKey {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** The production key. Missing env = the vault is unusable, by design. */
export function vaultKey(): VaultKey | null {
  const raw = process.env.HIREALPHA_VAULT_KEY?.trim() || ''
  if (!raw) return null
  return deriveVaultKey(raw)
}

/** Encrypt a secret. Same plaintext never yields the same ciphertext. */
export function encryptSecret(plain: string, key: VaultKey): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`
}

/** Decrypt, or null on tamper / wrong key / malformed payload. Never throws. */
export function decryptSecret(payload: string, key: VaultKey): string | null {
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  try {
    const iv = Buffer.from(parts[1]!, 'base64url')
    const tag = Buffer.from(parts[2]!, 'base64url')
    const ct = Buffer.from(parts[3]!, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) return null
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** Human-safe display form. Long secrets keep only their last two characters. */
export function maskSecret(payload: string): string {
  const tail = payload.slice(-2)
  return payload.length > 2 ? `••••${tail}` : '••••'
}
