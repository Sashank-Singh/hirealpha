import type { SQL } from 'bun'
import { normalizePhone } from '../utils/phone'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmailFormat(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 320
}

/** Guard for raw password input: string, 8 to 200 chars. */
export function isPlausiblePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200
}

/**
 * Passwords are hashed with Bun's argon2id. The plaintext and the hash are
 * never logged anywhere; handlers only touch them through these helpers.
 */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password)
}

/**
 * Constraint: the brute force brake is in memory and per process. After 8
 * wrong passwords for one email, that email is locked for 5 minutes. A
 * success clears the count. Failures only count when the account exists and
 * has a password, so never-registered addresses cannot be locked from outside.
 */
export class LoginLockoutTracker {
  private failures = new Map<string, { count: number; lockedUntil: number }>()
  private maxFailures: number
  private lockDurationMs: number

  constructor(maxFailures = 8, lockDurationMs = 5 * 60 * 1000) {
    this.maxFailures = maxFailures
    this.lockDurationMs = lockDurationMs
  }

  lockedRemainingMs(email: string): number {
    const entry = this.failures.get(email)
    if (!entry) return 0
    return Math.max(0, entry.lockedUntil - Date.now())
  }

  recordFailure(email: string): void {
    const entry = this.failures.get(email) || { count: 0, lockedUntil: 0 }
    entry.count += 1
    if (entry.count >= this.maxFailures) {
      entry.lockedUntil = Date.now() + this.lockDurationMs
      entry.count = 0
    }
    this.failures.set(email, entry)
  }

  clear(email: string): void {
    this.failures.delete(email)
  }

  reset(): void {
    this.failures.clear()
  }
}

export const defaultLoginLockout = new LoginLockoutTracker()

/** Test hook: resets the in-memory lockout table between test cases. */
export function resetLoginFailures(): void {
  defaultLoginLockout.reset()
}

/**
 * Public signup may only create a new account, never set a password on an
 * existing passwordless account. The insert is atomic against competing signups.
 */
export async function attachPasswordToAccount(
  sql: SQL,
  email: string,
  password: unknown,
  phone?: string | null,
): Promise<'set' | 'exists' | 'invalid' | 'skipped'> {
  const addr = String(email || '').trim().toLowerCase()
  if (!isValidEmailFormat(addr) || !isPlausiblePassword(password)) return 'invalid'
  try {
    const hash = await hashPassword(password)
    const rows = await sql`
      INSERT INTO hire_users (id, email, phone_e164, password_hash)
      VALUES (${crypto.randomUUID()}, ${addr}, ${normalizePhone(phone || '')}, ${hash})
      ON CONFLICT (email) DO NOTHING RETURNING id
    `
    return rows.length ? 'set' : 'exists'
  } catch {
    // Waitlist is not a conflict surface: a phone already owned by another
    // account (or any storage hiccup) just leaves the password unset.
    return 'skipped'
  }
}
