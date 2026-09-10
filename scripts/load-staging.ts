/** Load-protocol generator (Phase 9). Enqueues a controlled burst of browser
 * jobs for synthetic staging users and later reports queue latency.
 *
 * Run against STAGING only:  CERT_ALLOW_LIVE=1 CERT_DATABASE_URL=... bun run scripts/load-staging.ts
 * Refuses to run against anything whose DATABASE_URL/CERT_DATABASE_URL looks
 * like production (no `prod` check possible by name alone — require the host
 * to contain `staging`). */
import { SQL } from 'bun'

const url = process.env.CERT_DATABASE_URL?.trim() || ''
if (!process.env.CERT_ALLOW_LIVE || !url) {
  console.error('Refusing: set CERT_ALLOW_LIVE=1 and CERT_DATABASE_URL (staging only).')
  process.exit(1)
}
if (!/staging|localhost|127\.0\.0\.1/.test(url)) {
  console.error('Refusing: CERT_DATABASE_URL host does not look like staging/localhost.')
  process.exit(1)
}
const sql = new SQL(url, { max: 4 })

const users = Number(process.argv[2] || 5)
const jobsPerUser = Number(process.argv[3] || 4)
const url_target = process.argv[4] || 'https://example.com/'

console.log(`load: ${users} synthetic users × ${jobsPerUser} jobs → ${url_target}`)
const started = Date.now()
const ids: string[] = []
for (let u = 1; u <= users; u++) {
  const userId = `00000000-0000-4000-8000-${String(u).padStart(12, '0')}`
  await sql`
    INSERT INTO hire_users (id, email, created_at) VALUES (${userId}, ${`load${u}@staging.local`}, now())
    ON CONFLICT (id) DO NOTHING
  `
  for (let j = 1; j <= jobsPerUser; j++) {
    const id = crypto.randomUUID()
    // Approval + job inserted directly (staging data, synthetic users only).
    await sql`
      INSERT INTO hire_browser_approvals (id, user_id, persona, portal, origin, purpose, status)
      VALUES (${id}, ${userId}, 'friend', ${url_target}, ${new URL(url_target).origin}, 'load test', 'approved')
      ON CONFLICT (id) DO NOTHING
    `
    await sql`
      INSERT INTO hire_browser_jobs (id, user_id, persona, kind, url, goal, status, approval_id, created_at)
      VALUES (${id}, ${userId}, 'friend', 'task', ${url_target}, 'Load-test page read; report the page title.', 'pending', ${id}, now())
      ON CONFLICT (id) DO NOTHING
    `
    ids.push(id)
  }
  await Bun.sleep(200) // ~1 job/s pacing per the protocol
}
console.log(`queued ${ids.length} jobs in ${((Date.now() - started) / 1000).toFixed(1)}s`)

// Watch progress for up to 10 minutes; report latency percentiles.
const deadline = Date.now() + 10 * 60_000
const t0 = new Map<string, number>()
for (const id of ids) {
  const r = (await sql`SELECT created_at FROM hire_browser_jobs WHERE id = ${id}`) as Array<{ created_at: Date }>
  t0.set(id, new Date(r[0]!.created_at).getTime())
}
while (Date.now() < deadline) {
  const rows = (await sql`
    SELECT id, status, finished_at FROM hire_browser_jobs WHERE id = ANY(${ids})
  `) as Array<{ id: string; status: string; finished_at: Date | null }>
  const done = rows.filter((r) => r.status === 'done' || r.status === 'failed')
  if (done.length === ids.length) {
    const waits = done
      .filter((r) => r.finished_at)
      .map((r) => ((new Date(r.finished_at!).getTime() - t0.get(r.id)!) / 1000))
      .sort((a, b) => a - b)
    const pct = (p: number) => waits[Math.floor(waits.length * p)]?.toFixed(1) ?? '—'
    console.log(`done=${done.length}/${ids.length} status=${done.map((d) => d.status).join(',')}`)
    console.log(`end-to-end seconds: p50=${pct(0.5)} p95=${pct(0.95)}`)
    break
  }
  await Bun.sleep(5_000)
}
await sql.close()
console.log('verify separately: no shared sandbox ids (task_environments), all destroyed, E2B dashboard cost per task.')
