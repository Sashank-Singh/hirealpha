import type { SQL } from 'bun'
import { isPersona, type Persona } from '../personas'
import { json } from '../utils/http'
import { normalizePhone } from '../utils/phone'
import {
  ensureInvites,
  referralProgress,
  claimInvite,
  referralFreeMonths,
} from '../db/invites'
import { claimIntros, ackIntro } from '../db/intros'

export async function handleInviteRoutes(
  req: Request,
  sql: SQL,
  options?: { internalOk?: (r: Request) => boolean },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/invites/for-phone' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    try {
      const codes = await ensureInvites(sql, phone)
      const progress = await referralProgress(sql, phone)
      return json({ codes, ...progress })
    } catch (err) {
      console.error('[invites] ensure failed', err)
      return json({ error: 'Could not create invites' }, 500)
    }
  }

  if (path === '/api/invites/redeem' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { code?: string; phone?: string }
    const result = await claimInvite(sql, body.phone || '', body.code || '')
    if (!result.ok) {
      const status =
        result.error === 'Code not found' ? 404 : result.error === 'This code was already used' ? 409 : 400
      return json({ error: result.error }, status)
    }
    return json({ ok: true, referrer: result.referrer, reward: result.reward })
  }

  // Referral balance for a phone: its codes, how many are redeemed, and how
  // many free months are still unspent. Phone-only lookup, same as for-phone.
  if (path === '/api/invites/status' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    try {
      const codes = await ensureInvites(sql, phone)
      const progress = await referralProgress(sql, phone)
      const freeMonths = await referralFreeMonths(sql, phone)
      return json({ codes, redeemedCount: progress.referrals, freeMonths })
    } catch (err) {
      console.error('[invites] status failed', err)
      return json({ error: 'Could not read invites' }, 500)
    }
  }

  // Approximate waitlist spot: everyone who queued before this phone in the
  // intro queue, plus the email waitlist as one block. Good enough for a
  // "you are number N" screen; not an audit trail.
  if (path === '/api/invites/position' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = (await sql`
      SELECT
        (SELECT count(*) FROM hire_intro_queue WHERE created_at < COALESCE(
          (SELECT min(created_at) FROM hire_intro_queue WHERE phone_e164 = ${phone}), now())
        ) AS ahead,
        (SELECT count(*) FROM waitlist_emails) AS waiting
    `) as Array<{ ahead: string | number; waiting: string | number }>
    const ahead = Number(rows[0]?.ahead ?? 0)
    const waiting = Number(rows[0]?.waiting ?? 0)
    return json({ position: ahead + waiting })
  }

  if (path === '/api/internal/intros/claim' && req.method === 'GET') {
    if (!options?.internalOk?.(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 3, 1), 10)
    const intros = await claimIntros(sql, persona as Persona, limit)
    return json({ intros })
  }

  if (path === '/api/internal/intros/ack' && req.method === 'POST') {
    if (!options?.internalOk?.(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { id?: string; ok?: boolean; error?: string }
    if (!body.id) return json({ error: 'id required' }, 400)
    await ackIntro(sql, body.id, body.ok !== false, body.error)
    return json({ ok: true })
  }

  return null
}
