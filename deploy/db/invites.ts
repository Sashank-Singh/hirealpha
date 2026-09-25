import type { SQL } from 'bun'
import { normalizePhone } from '../utils/phone'

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let suffix = ''
  for (const byte of bytes) suffix += INVITE_ALPHABET[byte % INVITE_ALPHABET.length]
  return `ALPHA-${suffix}`
}

/** Idempotently make sure a phone has its three codes. Re-reads after every
 * insert so a rare code collision with another phone cannot short the count. */
export async function ensureInvites(sql: SQL, phone: string): Promise<string[]> {
  const e164 = normalizePhone(phone)
  if (!e164) throw new Error('invalid phone')
  const codes = async () =>
    ((await sql`
      SELECT code FROM hire_invites WHERE phone_e164 = ${e164} ORDER BY created_at
    `) as Array<{ code: string }>).map((r) => r.code)
  let mine = await codes()
  for (let guard = 0; guard < 10 && mine.length < 3; guard++) {
    await sql`
      INSERT INTO hire_invites (code, phone_e164)
      VALUES (${generateInviteCode()}, ${e164})
      ON CONFLICT (code) DO NOTHING
    `
    mine = await codes()
  }
  return mine.slice(0, 3)
}

/* ---- Referral loop ----
 * One-use codes are the whole mechanic: the invite holder shares a code, the
 * friend enters it, the code is marked used, and the referrer earns one
 * hire_referral_credits row per converted code. Each credit is a free month
 * applied automatically at the referrer's next checkout. */

export type ClaimResult = { ok: boolean; error?: string; referrer?: string; reward?: number }

export async function claimInvite(sql: SQL, phone: string, code: string): Promise<ClaimResult> {
  const e164 = normalizePhone(phone)
  const clean = code.trim().toUpperCase()
  if (!e164) return { ok: false, error: 'valid phone required' }
  if (!clean) return { ok: false, error: 'code required' }
  const rows = (await sql`
    SELECT phone_e164 AS referrer, redeemed_by_phone AS redeemed
    FROM hire_invites WHERE code = ${clean} LIMIT 1
  `) as Array<{ referrer: string; redeemed: string | null }>
  const invite = rows[0]
  if (!invite) return { ok: false, error: 'Code not found' }
  if (invite.redeemed) return { ok: false, error: 'This code was already used' }
  await sql`
    UPDATE hire_invites SET redeemed_by_phone = ${e164}, redeemed_at = now()
    WHERE code = ${clean}
  `
  // Refer a friend, get a free month: the referrer earns one credit per
  // converted code. source_code UNIQUE is the idempotency guard.
  await sql`
    INSERT INTO hire_referral_credits (id, phone_e164, source_code)
    VALUES (${crypto.randomUUID()}, ${invite.referrer}, ${clean})
    ON CONFLICT (source_code) DO NOTHING
  `
  // One converted code is one credit; the old every-3 mechanic is retired.
  return { ok: true, referrer: invite.referrer, reward: 1 }
}

/** Progress for the referrer's invite row: how many codes are used. */
export async function referralProgress(
  sql: SQL,
  phone: string,
): Promise<{ referrals: number }> {
  const e164 = normalizePhone(phone)
  if (!e164) return { referrals: 0 }
  const countRows = (await sql`
    SELECT count(*)::int AS n FROM hire_invites
    WHERE phone_e164 = ${e164} AND redeemed_by_phone IS NOT NULL
  `) as Array<{ n: number | string }>
  const n = Number(countRows[0]?.n ?? 0)
  return { referrals: Number.isFinite(n) ? n : 0 }
}

/** Unused referral credits for a phone, i.e. free months waiting to be
 * applied at checkout. Used rows no longer count. */
export async function referralFreeMonths(sql: SQL, phone: string): Promise<number> {
  const e164 = normalizePhone(phone)
  if (!e164) return 0
  const rows = (await sql`
    SELECT count(*)::int AS n FROM hire_referral_credits
    WHERE phone_e164 = ${e164} AND used_at IS NULL
  `) as Array<{ n: number | string }>
  const n = Number(rows[0]?.n ?? 0)
  return Number.isFinite(n) ? n : 0
}
