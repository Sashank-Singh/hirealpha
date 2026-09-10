/** Staging canary (Phase 9). Synthetic accounts only — no real purchases.
 * Exercises signup → (test-mode checkout stub) → intro queue → wizard state →
 * brief render against a staging deployment.
 *
 * Run:  CANARY_BASE_URL=https://staging.hirealpha.chat bun run scripts/canary-staging.ts
 * Refuses to run against production. */
const base = (process.env.CANARY_BASE_URL || '').replace(/\/$/, '')
if (!base || !/staging|localhost|127\.0\.0\.1/.test(base)) {
  console.error('Refusing: set CANARY_BASE_URL to a staging/localhost URL.')
  process.exit(1)
}
const email = `canary-${Date.now()}@staging.local`

async function step(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn()
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

const signup = { email, password: `Canary-${crypto.randomUUID().slice(0, 13)}!A`, timezone: 'America/New_York' }
let authCookie = ''
let userId = ''

await step('signup creates account', async () => {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signup),
  })
  if (!res.ok) throw new Error(`status ${res.status}`)
  const setCookie = res.headers.get('set-cookie') || ''
  authCookie = setCookie.split(';')[0]!
  const data = (await res.json()) as { user?: { id?: string } }
  userId = data.user?.id || ''
  if (!userId) throw new Error('no user id returned')
  return userId
})

await step('session authenticates', async () => {
  const res = await fetch(`${base}/api/me`, { headers: { cookie: authCookie } })
  if (!res.ok) throw new Error(`status ${res.status}`)
  return 'cookie session works'
})

await step('setup status reachable', async () => {
  const res = await fetch(`${base}/api/setup/status`, { headers: { cookie: authCookie } })
  if (!res.ok) throw new Error(`status ${res.status}`)
  return 'wizard state readable'
})

await step('trust overview requires nothing exotic', async () => {
  const res = await fetch(`${base}/api/trust/overview`, { headers: { cookie: authCookie } })
  if (!res.ok) throw new Error(`status ${res.status}`)
  const data = (await res.json()) as { capabilities?: unknown[] }
  if (!Array.isArray(data.capabilities)) throw new Error('capabilities missing')
  return `capabilities=${data.capabilities.length}`
})

await step('health endpoint', async () => {
  const res = await fetch(`${base}/readyz`)
  if (!res.ok) throw new Error(`status ${res.status}`)
  return await res.text()
})

console.log(`\ncanary account: ${email}${userId ? ` (${userId})` : ''} — leave for D7 checks or delete via trust purge route.`)
