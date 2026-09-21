/**
 * Wipe one account, so the person can join again as a new user.
 *
 * Written for the founder's own request, 2026-09-21, verbatim: "lets rerset the db
 * so singhsashank08@gmail.com and 21630332166 data is wiped and i can rejoin as a
 * new user". The account is NOT deleted from Photon — the assigned line stays —
 * and no other account is touched.
 *
 * Usage (inside the cluster, where DATABASE_URL lives):
 *
 *   bun wipeAccount.ts <email> [phone]            # report only, changes nothing
 *   bun wipeAccount.ts <email> [phone] --yes      # delete
 *
 * Dry run by default, and it refuses to delete without the phone matching when a
 * phone is given: a wipe is not something to get wrong on the first try.
 */
import { SQL } from 'bun'

const [, , emailArg, phoneArg] = process.argv
const email = String(emailArg || '').trim().toLowerCase()
const phone = String(phoneArg || '').trim()
const confirmed = process.argv.includes('--yes')

if (!email && !phone) {
  console.error('usage: bun wipeAccount.ts <email> [phone] [--yes]')
  process.exit(2)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(2)
}
const sql = new SQL(url, { max: 2, idleTimeout: 10, connectionTimeout: 10 })

/** Every table that hangs off a user, found rather than hardcoded: the schema has
 * grown past thirty tables and a hand-written list would quietly miss the last
 * few added. */
async function userColumns(): Promise<Array<{ table: string; column: string }>> {
  const rows = (await sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('user_id', 'phone_e164')
    ORDER BY table_name
  `) as Array<{ table_name: string; column_name: string }>
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }))
}

async function main() {
  const users = (await sql`
    SELECT id, email, phone_e164, name, assigned_phone, created_at FROM hire_users
    WHERE ${email ? sql`lower(email) = ${email}` : sql`phone_e164 = ${phone}`}
    LIMIT 1
  `) as Array<{ id: string; email: string; phone_e164: string | null; name: string | null; assigned_phone: string | null; created_at: string }>

  const user = users[0]
  if (!user) {
    console.log(`no account matches ${email || phone} — nothing to do`)
    return
  }
  // A bare 10-digit US number is the same number as its +1 form: the first run of
  // this tool refused the founder's own hand-typed "2163032166", which is a
  // helpful refusal in the wrong direction.
  const digits = (value: string | null) => {
    const d = String(value || '').replace(/\D/g, '')
    return d.length === 10 ? `1${d}` : d
  }
  if (email && phone && digits(user.phone_e164) !== digits(phone)) {
    console.error(`refusing: ${email} is on ${user.phone_e164}, not ${phone}`)
    process.exit(3)
  }

  console.log(`account: ${user.id}`)
  console.log(`  email:    ${user.email}`)
  console.log(`  phone:    ${user.phone_e164}`)
  console.log(`  name:     ${user.name}`)
  console.log(`  line:     ${user.assigned_phone}`)
  console.log(`  created:  ${user.created_at}`)

  const columns = await userColumns()
  const plan: Array<{ table: string; column: string; count: number }> = []
  for (const { table, column } of columns) {
    const value = column === 'user_id' ? user.id : (user.phone_e164 || phone)
    if (!value) continue
    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${table}" WHERE ${column} = $1`,
      [value],
    )) as Array<{ n: number }>
    const count = rows[0]?.n || 0
    if (count) plan.push({ table, column, count })
  }

  console.log(`\nrows tied to this account (${plan.length} tables):`)
  for (const row of plan.sort((a, b) => b.count - a.count)) {
    console.log(`  ${String(row.count).padStart(6)}  ${row.table}.${row.column}`)
  }
  if (!plan.length) console.log('  (none)')

  if (!confirmed) {
    console.log('\ndry run — nothing changed. Re-run with --yes to delete.')
    return
  }

  await sql.begin(async (tx) => {
    for (const row of plan) {
      const value = row.column === 'user_id' ? user.id : (user.phone_e164 || phone)
      await tx.unsafe(`DELETE FROM "${row.table}" WHERE ${row.column} = $1`, [value])
    }
    await tx`DELETE FROM hire_users WHERE id = ${user.id}`
  })

  // Read back, so the report is what the database actually holds now.
  const left = (await sql`SELECT count(*)::int AS n FROM hire_users WHERE id = ${user.id}`) as Array<{ n: number }>
  console.log(`\ndeleted. hire_users rows left for this id: ${left[0]?.n ?? 'unknown'}`)
  console.log('the account can sign up again as a new user; the Photon line is untouched.')
}

await main()
await sql.end()
