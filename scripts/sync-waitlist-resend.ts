#!/usr/bin/env bun
/**
 * Backfill: sync every stored waitlist email into the Resend audience so the
 * launch broadcast reaches people who joined before the integration existed.
 *
 *   RESEND_API_KEY=re_... RESEND_AUDIENCE_ID=... DATABASE_URL=postgres://... \
 *   bun scripts/sync-waitlist-resend.ts
 *
 * Idempotent (Resend upserts contacts by email). Run once before launch day.
 */
import { SQL } from 'bun'

const key = process.env.RESEND_API_KEY?.trim() || ''
const audience = process.env.RESEND_AUDIENCE_ID?.trim() || ''
const databaseUrl = process.env.DATABASE_URL || ''

if (!key || !audience || !databaseUrl) {
  console.log(
    'Usage: RESEND_API_KEY=... RESEND_AUDIENCE_ID=... DATABASE_URL=... bun scripts/sync-waitlist-resend.ts',
  )
  process.exit(1)
}

const sql = new SQL(databaseUrl, {
  max: 4,
  idleTimeout: 10,
  connectionTimeout: 10,
  connection: { options: '-c timezone=UTC' },
})

const rows = (await sql`SELECT email FROM waitlist_emails ORDER BY created_at`) as Array<{ email: string }>
console.log(`[resend] ${rows.length} emails to sync`)

let ok = 0
let failed = 0
for (const { email } of rows) {
  const res = await fetch(`https://api.resend.com/audiences/${audience}/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, unsubscribed: false }),
  })
  if (res.ok) {
    ok++
  } else {
    failed++
    console.warn(`[resend] failed ${email}: ${res.status}`, (await res.text()).slice(0, 120))
  }
  if (ok % 20 === 0) await Bun.sleep(500)
}

console.log(`[resend] done. synced ${ok}, failed ${failed}`)
process.exit(failed ? 1 : 0)