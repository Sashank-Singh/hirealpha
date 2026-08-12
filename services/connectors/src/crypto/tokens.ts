/**
 * Envelope encryption for OAuth tokens at rest (AES-256-GCM).
 *
 * Production: load TOKEN_ENCRYPTION_KEY from a secrets manager / KMS-unwrapped DEK.
 * Never commit real keys. Never log plaintext tokens.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_ENV = 'TOKEN_ENCRYPTION_KEY'
const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

export function loadMasterKey(fromEnv = process.env): Buffer {
  const raw = fromEnv[KEY_ENV]
  if (!raw) {
    throw new Error(`${KEY_ENV} must be set (32-byte key, base64-encoded)`)
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must decode to exactly 32 bytes`)
  }
  return key
}

/** Generate a key for local/dev (do not use in production). */
export function generateMasterKey(): string {
  return randomBytes(32).toString('base64')
}

/**
 * Encrypt plaintext → `v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`
 */
export function encryptToken(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, masterKey, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decryptToken(blob: string, masterKey: Buffer): string {
  const [version, ivB64, tagB64, dataB64] = blob.split(':')
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid ciphertext envelope')
  }
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Invalid ciphertext envelope lengths')
  }
  const decipher = createDecipheriv(ALGO, masterKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

const TOKENISH =
  /\b(ya29\.|xox[baprs]-|ghp_|gho_|sk_live_|sk_test_|BQ[A-Za-z0-9_\-]{20,}|secret_[A-Za-z0-9]+|[A-Za-z0-9_\-]{32,}\.[A-Za-z0-9_\-]{10,})\b/g

/** Redact token-like strings before logging or writing audit summaries. */
export function redactSecrets(text: string): string {
  return text.replace(TOKENISH, '[REDACTED]')
}
