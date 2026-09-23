import type { SQL } from 'bun'
import { normalizePhone } from '../utils/phone'
import { resolveIanaTimezone } from '../timezones'
import { requestIdentity } from '../auth/identity'

export type AuthedUser = {
  id: string
  email: string
  name: string | null
  timezone: string | null
  phone: string | null
  assignedPhone?: string | null
}

export async function getUserByEmail(sql: SQL, email: string): Promise<AuthedUser | null> {
  const rows = await sql`
    SELECT id, email, name, timezone, phone_e164 AS phone, assigned_phone AS "assignedPhone" FROM hire_users WHERE email = ${email} LIMIT 1
  `
  return (rows[0] as AuthedUser | undefined) ?? null
}

export async function linkPhoneIfMissing(sql: SQL, user: AuthedUser, e164: string): Promise<AuthedUser> {
  if (user.phone || !e164) return user
  try {
    await sql`
      UPDATE hire_users SET phone_e164 = ${e164}, updated_at = now()
      WHERE id = ${user.id} AND phone_e164 IS NULL
    `
    user.phone = e164
  } catch {
    // Unique conflict: another account already owns this number.
  }
  return user
}

export async function getUserByPhone(sql: SQL, phone: string): Promise<AuthedUser | null> {
  const raw = String(phone || '').trim()
  if (raw.includes('@')) {
    const byEmail = await getUserByEmail(sql, raw.toLowerCase())
    if (byEmail) return byEmail
  }
  const e164 = normalizePhone(raw)
  if (!e164) return null
  const last10 = e164.replace(/\D/g, '').slice(-10)
  const rows = await sql`
    SELECT id, email, name, timezone, phone_e164 AS phone, assigned_phone AS "assignedPhone" FROM hire_users
    WHERE phone_e164 = ${e164}
       OR right(regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g'), 10) = ${last10}
    LIMIT 1
  `
  const byPhone = (rows[0] as AuthedUser | undefined) ?? null
  if (byPhone) return byPhone

  const ticket = await sql`
    SELECT email FROM hire_login_tickets
    WHERE phone_e164 = ${e164}
       OR right(regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g'), 10) = ${last10}
    ORDER BY created_at DESC
    LIMIT 1
  `
  const ticketEmail = String((ticket[0] as { email?: string } | undefined)?.email || '')
    .trim()
    .toLowerCase()
  if (ticketEmail.includes('@')) {
    const fromTicket = await getUserByEmail(sql, ticketEmail)
    if (fromTicket) return linkPhoneIfMissing(sql, fromTicket, e164)
  }

  const mem = await sql`
    SELECT user_id AS id FROM hire_memories
    WHERE key IN ('phone', 'phone_e164', 'imessage', 'email')
      AND (
        right(regexp_replace(value, '[^0-9]', '', 'g'), 10) = ${last10}
        OR lower(btrim(value)) = ${raw.toLowerCase()}
      )
    LIMIT 1
  `
  const memId = (mem[0] as { id?: string } | undefined)?.id
  if (memId) {
    const urows = await sql`
      SELECT id, email, name, timezone, phone_e164 AS phone, assigned_phone AS "assignedPhone" FROM hire_users WHERE id = ${memId} LIMIT 1
    `
    const fromMem = (urows[0] as AuthedUser | undefined) ?? null
    if (fromMem) return linkPhoneIfMissing(sql, fromMem, e164)
  }
  return null
}

export async function ensureUser(
  sql: SQL,
  email: string,
  phone?: string | null,
  name?: string | null,
  timezone?: string | null,
): Promise<AuthedUser> {
  const existing = await getUserByEmail(sql, email)
  const e164 = normalizePhone(phone || '')
  const cleanName = name?.trim() ? name.trim() : null
  const cleanTz = resolveIanaTimezone(timezone)
  if (existing) {
    let changed = false
    if (e164 && existing.phone !== e164) {
      existing.phone = e164
      changed = true
    }
    if (cleanName && existing.name !== cleanName) {
      existing.name = cleanName
      changed = true
    }
    if (cleanTz && existing.timezone !== cleanTz) {
      existing.timezone = cleanTz
      changed = true
    }
    if (changed) {
      await sql`
        UPDATE hire_users SET
          phone_e164 = ${existing.phone},
          name = ${existing.name},
          timezone = ${existing.timezone},
          updated_at = now()
        WHERE id = ${existing.id}
      `
    }
    return existing
  }
  // A phone-first signup already created a placeholder row keyed on the
  // number; adopt it so this sign-in becomes the same person rather than
  // bouncing off the phone_e164 unique index.
  if (e164) {
    const byPhone = await getUserByPhone(sql, e164)
    if (byPhone) {
      // Knowing a phone number is not permission to rename its account.
      if (requestIdentity.getStore()?.email !== byPhone.email) throw new Error('That phone is already linked to another account')
      await sql`
        UPDATE hire_users SET
          email = ${email},
          name = ${cleanName || byPhone.name},
          timezone = ${cleanTz || byPhone.timezone},
          updated_at = now()
        WHERE id = ${byPhone.id}
      `
      return { id: byPhone.id, email, name: cleanName || byPhone.name, timezone: cleanTz || byPhone.timezone, phone: e164 }
    }
  }
  const id = crypto.randomUUID()
  await sql`
    INSERT INTO hire_users (id, email, name, timezone, phone_e164)
    VALUES (${id}, ${email}, ${cleanName}, ${cleanTz}, ${e164})
  `
  return { id, email, name: cleanName, timezone: cleanTz, phone: e164 }
}
