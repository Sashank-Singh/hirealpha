import type { SQL } from 'bun'
import { isPersona, type Persona } from '../personas'
import { normalizePhone } from '../utils/phone'
import { scheduleDay1Checkin } from '../loops/engine'

/** A bot stops retrying an intro after this many failed attempts; the signup
 * screen covers the rest by telling the person to text first. */
export const INTRO_MAX_ATTEMPTS = 5

/** Queue a first text: the bot for this persona picks the number up and says
 * hi before the person ever has to text first. No-op if already queued or
 * already greeted — a duplicate signup must not re-open the intro. */
export async function enqueueIntro(sql: SQL, phone: string, persona: Persona) {
  const e164 = normalizePhone(phone)
  if (!e164) throw new Error('invalid phone')
  if (!isPersona(persona)) throw new Error('invalid persona')
  await sql`
    INSERT INTO hire_intro_queue (id, phone_e164, persona)
    VALUES (${crypto.randomUUID()}, ${e164}, ${persona})
    ON CONFLICT (phone_e164, persona) DO NOTHING
  `
}

/** Hand pending intros for one persona to the bot that owns the line. A claim
 * bumps attempts immediately so a crashed bot cannot hold a row forever; rows
 * stuck in 'claiming' past the reset window go back to pending on the next
 * claim pass. */
export async function claimIntros(sql: SQL, persona: Persona, limit: number) {
  await sql`
    UPDATE hire_intro_queue SET status = 'pending'
    WHERE status = 'claiming' AND created_at < now() - interval '10 minutes'
  `
  const rows = (await sql`
    UPDATE hire_intro_queue SET status = 'claiming', attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM hire_intro_queue
      WHERE persona = ${persona} AND status = 'pending' AND attempts < ${INTRO_MAX_ATTEMPTS}
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, phone_e164 AS phone
  `) as Array<{ id: string; phone: string }>
  return rows
}

/** Schedule a task loop asking the user to save the bot number to contacts. */
export async function scheduleSaveContactLoop(sql: SQL, phone: string, persona: Persona) {
  const e164 = normalizePhone(phone)
  if (!e164 || !isPersona(persona)) return
  const rows = (await sql`
    SELECT id FROM hire_users WHERE phone_e164 = ${e164} LIMIT 1
  `) as Array<{ id: string }>
  const userId = rows[0]?.id
  if (!userId) return
  await sql`
    INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
    VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${e164}, 'save_contact',
      'Save this number to contacts', '{}'::jsonb, 'pending',
      ${new Date(Date.now() + 15 * 60 * 1000).toISOString()})
    ON CONFLICT (user_id, persona, kind) DO NOTHING
  `
}

export async function ackIntro(sql: SQL, id: string, ok: boolean, error?: string) {
  if (ok) {
    const rows = (await sql`
      UPDATE hire_intro_queue SET status = 'sent', sent_at = now(), last_error = NULL
      WHERE id = ${id} AND status = 'claiming'
      RETURNING phone_e164, persona
    `) as Array<{ phone_e164: string; persona: string }>
    const sent = rows[0]
    if (sent && isPersona(sent.persona)) {
      // The intro landed, so day 1 has started: arm the follow-up check-in.
      // A pre-migration database must not fail the ack over a missing table.
      try {
        await scheduleDay1Checkin(sql, sent.phone_e164, sent.persona)
      } catch (err) {
        console.warn('[hire] day1 checkin schedule failed', err)
      }
      // The intro carries Photon's native contact card; queue one later nudge
      // using the same native-first delivery path.
      try {
        await scheduleSaveContactLoop(sql, sent.phone_e164, sent.persona)
      } catch (err) {
        console.warn('[hire] save_contact schedule failed', err)
      }
    }
    return
  }
  // Failed claims with attempts left go back to pending for the next poll;
  // spent ones park as terminal failures.
  await sql`
    UPDATE hire_intro_queue SET
      status = CASE WHEN attempts < ${INTRO_MAX_ATTEMPTS} THEN 'pending' ELSE 'failed' END,
      last_error = ${String(error || '').slice(0, 500)}
    WHERE id = ${id} AND status = 'claiming'
  `
}
