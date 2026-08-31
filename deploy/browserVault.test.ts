import { describe, expect, it } from 'bun:test'
import { decryptSecret, deriveVaultKey, encryptSecret, maskSecret } from './vaultCrypto'
import {
  buildTickerChartCode,
  consumeBrowserApproval,
  decideBrowserApproval,
  deleteVaultEntry,
  extractNewsletterInsights,
  extractTickerRows,
  getVaultSecretForTask,
  handleVaultApi,
  listVaultEntries,
  requestBrowserApproval,
  runBrowserTask,
  saveVaultEntry,
  withUserBrowserLock,
  type PortalTask,
} from './browserVault'
import { gateWorkshopCode } from './workshop'

/* ============================================================================
 * Browser runner + credential vault — brutal tests.
 *
 * These pin down the moat: secrets never appear in plaintext outside a decrypt
 * call; one user can never touch another user's vault; a portal credential
 * never works against a different site; approvals are one-tap and one-time;
 * and browser tasks for a user serialize while different users never block.
 * ========================================================================== */

const KEY_A = deriveVaultKey('vault-key-a')
const KEY_B = deriveVaultKey('vault-key-b')

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string, values?: unknown[]) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?'), values))
  }) as never
  return { sql, queries }
}

/* ------------------------------- crypto --------------------------------- */

describe('vault crypto', () => {
  it('roundtrips a secret', () => {
    expect(decryptSecret(encryptSecret('hunter2!', KEY_A), KEY_A)).toBe('hunter2!')
  })

  it('roundtrips unicode and long secrets', () => {
    const s = 'p@§§wörd—🔐—' + 'x'.repeat(5000)
    expect(decryptSecret(encryptSecret(s, KEY_A), KEY_A)).toBe(s)
  })

  it('never encrypts the same plaintext to the same ciphertext (fresh IV)', () => {
    const a = encryptSecret('same-secret', KEY_A)
    const b = encryptSecret('same-secret', KEY_A)
    expect(a).not.toBe(b)
    expect(decryptSecret(a, KEY_A)).toBe('same-secret')
    expect(decryptSecret(b, KEY_A)).toBe('same-secret')
  })

  it('rejects a tampered ciphertext (GCM auth)', () => {
    const parts = encryptSecret('hunter2!', KEY_A).split('.')
    const ct = Buffer.from(parts[3]!, 'base64url')
    ct[0] = ct[0]! ^ 0xff
    parts[3] = ct.toString('base64url')
    expect(decryptSecret(parts.join('.'), KEY_A)).toBeNull()
  })

  it('rejects a tampered auth tag', () => {
    const parts = encryptSecret('hunter2!', KEY_A).split('.')
    const tag = Buffer.from(parts[2]!, 'base64url')
    tag[0] = tag[0]! ^ 0x01
    parts[2] = tag.toString('base64url')
    expect(decryptSecret(parts.join('.'), KEY_A)).toBeNull()
  })

  it('refuses to decrypt under a different key', () => {
    expect(decryptSecret(encryptSecret('hunter2!', KEY_A), KEY_B)).toBeNull()
  })

  it('refuses garbage and empty payloads', () => {
    expect(decryptSecret('', KEY_A)).toBeNull()
    expect(decryptSecret('not-a-payload', KEY_A)).toBeNull()
    expect(decryptSecret('v1.a.b', KEY_A)).toBeNull()
  })

  it('masks without leaking more than two trailing chars', () => {
    expect(maskSecret('hunter2!')).not.toContain('hunter')
    expect(maskSecret('hunter2!').endsWith('2!')).toBe(true)
    expect(maskSecret('ab')).toBe('••••')
  })
})

/* ----------------------------- vault store ------------------------------ */

const USER = 'u-alice'
const OTHER = 'u-mallory'

describe('vault store', () => {
  it('saves encrypted: plaintext never reaches SQL', async () => {
    const { sql, queries } = fakeSql()
    const res = await saveVaultEntry(sql, {
      userId: USER,
      persona: 'coworker',
      portal: 'https://portal.nseindia.com/login',
      secret: 'hunter2!',
      key: KEY_A,
    })
    expect(res.ok).toBe(true)
    const insert = queries.find((q) => /INSERT INTO hire_vault_entries/i.test(q.text))!
    expect(insert).toBeTruthy()
    const serialized = JSON.stringify(insert.values)
    expect(serialized).not.toContain('hunter2!')
    expect(serialized).not.toContain('/login')
  })

  it('upserts per (user, persona, portal) instead of duplicating', async () => {
    const { sql, queries } = fakeSql()
    await saveVaultEntry(sql, { userId: USER, persona: 'coworker', portal: 'https://portal.nseindia.com', secret: 'secreta', key: KEY_A })
    await saveVaultEntry(sql, { userId: USER, persona: 'coworker', portal: 'https://portal.nseindia.com/x', secret: 'secretb', key: KEY_A })
    const upserts = queries.filter((q) => /INSERT INTO hire_vault_entries/i.test(q.text))
    expect(upserts.length).toBe(2)
    for (const up of upserts) expect(up.text).toContain('ON CONFLICT')
  })

  it('rejects non-https and junk portals', async () => {
    const { sql } = fakeSql()
    for (const portal of ['http://portal.nseindia.com', 'not a url', 'javascript:alert(1)', '', 'ftp://x.com']) {
      const res = await saveVaultEntry(sql, { userId: USER, persona: 'coworker', portal, secret: 'hunter2!', key: KEY_A })
      expect(res.ok).toBe(false)
    }
  })

  it('rejects empty or tiny secrets', async () => {
    const { sql } = fakeSql()
    for (const secret of ['', 'ab']) {
      const res = await saveVaultEntry(sql, { userId: USER, persona: 'coworker', portal: 'https://x.com', secret, key: KEY_A })
      expect(res.ok).toBe(false)
    }
  })

  it('lists masked entries and never leaks plaintext', async () => {
    const { sql } = fakeSql(() => [
      { id: 'e1', persona: 'coworker', portal: 'portal.nseindia.com', origin: 'https://portal.nseindia.com', secret_encrypted: encryptSecret('hunter2!', KEY_A), created_at: new Date(), last_used_at: null },
    ])
    const list = await listVaultEntries(sql, USER, KEY_A)
    expect(list.length).toBe(1)
    expect(JSON.stringify(list)).not.toContain('hunter2!')
    expect(list[0]!.masked).toContain('••')
  })

  it('deletes only its own entries', async () => {
    const { sql, queries } = fakeSql((text) => (/DELETE FROM hire_vault_entries/i.test(text) ? [{ id: 'e1' }] : []))
    expect(await deleteVaultEntry(sql, USER, 'e1')).toBe(true)
    const del = queries.find((q) => /DELETE FROM hire_vault_entries/i.test(q.text))!
    expect(del.text).toContain('user_id')
    expect(del.values).toContain(USER)
    expect(del.values).toContain('e1')
  })

  it('hands out the secret only for the exact portal origin (scope fence)', async () => {
    const { sql } = fakeSql((text, values) =>
      /FROM hire_vault_entries/i.test(text) && values?.includes('https://portal.nseindia.com')
        ? [{ id: 'e1', secret_encrypted: encryptSecret('hunter2!', KEY_A) }]
        : [],
    )
    const ok = await getVaultSecretForTask(sql, USER, 'https://portal.nseindia.com', KEY_A)
    expect(ok).toBe('hunter2!')
    const evil = await getVaultSecretForTask(sql, USER, 'https://evil.example.com', KEY_A)
    expect(evil).toBeNull()
  })

  it('never decrypts for a different user', async () => {
    const { sql } = fakeSql(() => [])
    const res = await getVaultSecretForTask(sql, OTHER, 'https://portal.nseindia.com', KEY_A)
    expect(res).toBeNull()
  })
})

/* --------------------------- approval gates ----------------------------- */

describe('approval gates', () => {
  it('creates a pending approval', async () => {
    const { sql, queries } = fakeSql()
    const req = await requestBrowserApproval(sql, { userId: USER, persona: 'coworker', portal: 'https://portal.nseindia.com', purpose: 'Read your NSE session' })
    expect(req.requestId).toBeTruthy()
    const insert = queries.find((q) => /INSERT INTO hire_browser_approvals/i.test(q.text))!
    expect(insert.text).toContain("'pending'")
  })

  it('deny blocks the task', async () => {
    const { sql } = fakeSql((text) =>
      /FROM hire_browser_approvals/i.test(text) && !/UPDATE/i.test(text)
        ? [{ id: 'r1', status: 'denied', origin: 'https://portal.nseindia.com', created_at: new Date(), consumed_at: null }]
        : [],
    )
    expect(await consumeBrowserApproval(sql, USER, 'r1', 'https://portal.nseindia.com')).toBe('denied')
  })

  it('approve → consume once; the second consume is used', async () => {
    let status: Record<string, unknown> = { id: 'r1', status: 'approved', origin: 'https://portal.nseindia.com', created_at: new Date(), consumed_at: null }
    const { sql } = fakeSql((text) => {
      if (/FROM hire_browser_approvals/i.test(text) && !/UPDATE/i.test(text)) return [status]
      if (/UPDATE hire_browser_approvals/i.test(text)) {
        status = { ...status, consumed_at: new Date() }
        return [{ id: 'r1' }]
      }
      return []
    })
    expect(await consumeBrowserApproval(sql, USER, 'r1', 'https://portal.nseindia.com')).toBe('ok')
    status = { ...status, consumed_at: new Date() }
    expect(await consumeBrowserApproval(sql, USER, 'r1', 'https://portal.nseindia.com')).toBe('used')
  })

  it('consumes the approval atomically: the UPDATE carries the pending guard', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_browser_approvals/i.test(text) && !/UPDATE/i.test(text)
        ? [{ id: 'r1', status: 'approved', origin: 'https://portal.nseindia.com', created_at: new Date(), consumed_at: null }]
        : [{ id: 'r1' }],
    )
    await consumeBrowserApproval(sql, USER, 'r1', 'https://portal.nseindia.com')
    const update = queries.find((q) => /UPDATE hire_browser_approvals/i.test(q.text))!
    expect(update.text).toContain('consumed_at IS NULL')
  })

  it('refuses a consumed approval from a different origin (scope fence)', async () => {
    const { sql } = fakeSql((text) =>
      /FROM hire_browser_approvals/i.test(text) && !/UPDATE/i.test(text)
        ? [{ id: 'r1', status: 'approved', origin: 'https://portal.nseindia.com', created_at: new Date(), consumed_at: null }]
        : []
    )
    expect(await consumeBrowserApproval(sql, USER, 'r1', 'https://evil.example.com')).toBe('scope')
  })

  it('expires stale approvals', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000)
    const { sql } = fakeSql((text) =>
      /FROM hire_browser_approvals/i.test(text) && !/UPDATE/i.test(text)
        ? [{ id: 'r1', status: 'approved', origin: 'https://portal.nseindia.com', created_at: old, consumed_at: null }]
        : [{ id: 'r1' }],
    )
    expect(await consumeBrowserApproval(sql, USER, 'r1', 'https://portal.nseindia.com')).toBe('expired')
  })

  it('only the owner can decide an approval', async () => {
    const { sql, queries } = fakeSql()
    await decideBrowserApproval(sql, OTHER, 'r1', 'deny')
    const update = queries.find((q) => /UPDATE hire_browser_approvals/i.test(q.text))!
    expect(update.values).toContain(OTHER)
    expect(update.text).toContain('user_id')
  })
})

/* ----------------------------- session lock ----------------------------- */

describe('per-user browser session lock', () => {
  it('serializes tasks for the same user (one session per user)', async () => {
    const events: string[] = []
    const task = (id: string, ms: number) =>
      withUserBrowserLock(USER, async () => {
        events.push(`start:${id}`)
        await new Promise((r) => setTimeout(r, ms))
        events.push(`end:${id}`)
        return id
      })
    const [a, b] = await Promise.all([task('a', 30), task('b', 5)])
    expect([a, b]).toEqual(['a', 'b'])
    const starts = events.filter((e) => e.startsWith('start'))
    const ends = events.filter((e) => e.startsWith('end'))
    expect(events.slice(0, 2)).toEqual([starts[0], ends[0]])
    expect(events.slice(2, 4)).toEqual([starts[1], ends[1]])
  })

  it('never blocks a different user (isolation)', async () => {
    let releaseAlice!: () => void
    const gate = new Promise<void>((r) => (releaseAlice = r))
    const alice = withUserBrowserLock(USER, async () => {
      await gate
      return 'alice-done'
    })
    const bob = withUserBrowserLock(OTHER, async () => 'bob-done')
    expect(await bob).toBe('bob-done')
    releaseAlice()
    expect(await alice).toBe('alice-done')
  })

  it('releases the lock when a task throws', async () => {
    await withUserBrowserLock(USER, async () => {
      throw new Error('boom')
    }).catch(() => {})
    expect(await withUserBrowserLock(USER, async () => 'recovered')).toBe('recovered')
  })

  it('propagates the task error to its own caller', async () => {
    await expect(
      withUserBrowserLock(USER, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})

/* ------------------------ runner orchestration -------------------------- */

const NSE = 'https://portal.nseindia.com'

function deps(overrides: Partial<{ launchError: Error | null }> = {}) {
  const launched: PortalTask[] = []
  return {
    launched,
    launch: async (task: PortalTask) => {
      launched.push(task)
      if (overrides.launchError) throw overrides.launchError
      if (task.kind === 'ticker') {
        return { ok: true as const, content: 'RELIANCE 2,930.10 +1.2%\nTCS 4,102.30 -0.4%' }
      }
      return { ok: true as const, content: 'Markets wrap: Nifty ends higher.\nBank Nifty snaps 3-day streak.' }
    },
  }
}

function sqlForTask(opts: { approval?: string; secret?: string | null } = {}) {
  return fakeSql((text) => {
    if (/FROM hire_browser_approvals/i.test(text) && !/UPDATE/i.test(text)) {
      return opts.approval === undefined
        ? []
        : [{ id: 'r1', status: opts.approval, origin: NSE, created_at: new Date(), consumed_at: null }]
    }
    if (/UPDATE hire_browser_approvals/i.test(text)) return [{ id: 'r1' }]
    if (/FROM hire_vault_entries/i.test(text)) {
      return opts.secret === undefined ? [] : [{ id: 'e1', secret_encrypted: opts.secret ? encryptSecret(opts.secret, KEY_A) : null }]
    }
    return []
  })
}

describe('browser task orchestration', () => {
  it('refuses to launch without an approval — the fence is default-deny', async () => {
    const { sql } = sqlForTask()
    const d = deps()
    const res = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'newsletter', url: NSE, key: KEY_A })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('approval_required')
    expect(d.launched.length).toBe(0)
  })

  it('refuses to launch on a denied approval', async () => {
    const { sql } = sqlForTask({ approval: 'denied' })
    const d = deps()
    const res = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'newsletter', url: NSE, key: KEY_A })
    expect(res.ok).toBe(false)
    expect(d.launched.length).toBe(0)
  })

  it('refuses to launch with no vault entry for that portal', async () => {
    const { sql } = sqlForTask({ approval: 'approved' })
    const d = deps()
    const res = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'newsletter', url: NSE, key: KEY_A })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('vault_missing')
    expect(d.launched.length).toBe(0)
  })

  it('refuses to launch when the URL does not match the approved portal', async () => {
    const { sql } = sqlForTask({ approval: 'approved', secret: 'hunter2!' })
    const d = deps()
    const res = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'newsletter', url: 'https://evil.example.com', key: KEY_A })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('approval_required')
    expect(d.launched.length).toBe(0)
  })

  it('happy path: launches once with the decrypted credential and returns insights', async () => {
    const { sql } = sqlForTask({ approval: 'approved', secret: 'hunter2!' })
    const d = deps()
    const res = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'newsletter', url: NSE, key: KEY_A })
    expect(res.ok).toBe(true)
    expect(d.launched.length).toBe(1)
    expect(d.launched[0]!.password).toBe('hunter2!')
    if (res.ok) expect(res.insights).toContain('Nifty ends higher')
    expect(JSON.stringify(res)).not.toContain('hunter2!')
  })

  it('ticker tasks return baked-in workshop chart code', async () => {
    const { sql } = sqlForTask({ approval: 'approved', secret: 'hunter2!' })
    const d = deps()
    const res = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'ticker', url: NSE, key: KEY_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.kind).toBe('ticker')
    expect(res.chartCode).toContain('RELIANCE')
    expect(gateWorkshopCode(res.chartCode || '').ok).toBe(true)
  })

  it('a consumed approval cannot power a second task', async () => {
    let consumed = false
    const { sql } = fakeSql((text) => {
      if (/FROM hire_browser_approvals/i.test(text) && !/UPDATE/i.test(text)) {
        return consumed ? [] : [{ id: 'r1', status: 'approved', origin: NSE, created_at: new Date(), consumed_at: null }]
      }
      if (/UPDATE hire_browser_approvals/i.test(text)) {
        consumed = true
        return [{ id: 'r1' }]
      }
      if (/FROM hire_vault_entries/i.test(text)) return [{ id: 'e1', secret_encrypted: encryptSecret('hunter2!', KEY_A) }]
      return []
    })
    const d = deps()
    const first = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'newsletter', url: NSE, key: KEY_A })
    expect(first.ok).toBe(true)
    const second = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'newsletter', url: NSE, key: KEY_A })
    expect(second.ok).toBe(false)
    expect(d.launched.length).toBe(1)
  })

  it('runner errors come back as task failures, not crashes', async () => {
    const { sql } = sqlForTask({ approval: 'approved', secret: 'hunter2!' })
    const d = deps({ launchError: new Error('page exploded') })
    const res = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'newsletter', url: NSE, key: KEY_A })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('runner_failed')
  })

  it('rejects non-https task URLs outright', async () => {
    const { sql } = sqlForTask({ approval: 'approved', secret: 'hunter2!' })
    const d = deps()
    const res = await runBrowserTask(d, sql, { userId: USER, persona: 'coworker', requestId: 'r1', kind: 'newsletter', url: 'http://portal.nseindia.com', key: KEY_A })
    expect(res.ok).toBe(false)
    expect(d.launched.length).toBe(0)
  })
})

/* ------------------------- extraction parsing --------------------------- */

describe('extraction parsing (pure, no browser)', () => {
  it('ticker rows: parses symbol, price, change; tolerates thousands separators', () => {
    const rows = extractTickerRows('RELIANCE 2,930.10 +1.2%\nTCS 4,102.30 -0.4%\ngarbage line')
    expect(rows).toEqual([
      { symbol: 'RELIANCE', price: 2930.1, changePct: 1.2 },
      { symbol: 'TCS', price: 4102.3, changePct: -0.4 },
    ])
  })

  it('ticker rows: empty input → no rows, never a throw', () => {
    expect(extractTickerRows('')).toEqual([])
    expect(extractTickerRows('no numbers here at all')).toEqual([])
  })

  it('newsletter insights: keeps meaningful lines, drops nav noise', () => {
    const insights = extractNewsletterInsights(
      'Menu Subscribe Sign in\n\nMarkets wrap: Nifty ends higher.\n\nBank Nifty snaps 3-day streak.\n\n© 2026 Portal',
    )
    expect(insights).toContain('Nifty ends higher')
    expect(insights).toContain('snaps 3-day streak')
    expect(insights).not.toContain('Subscribe')
  })

  it('newsletter insights: caps the text a turn engine will read', () => {
    const big = Array.from({ length: 400 }, (_, i) => `Line ${i} with words`).join('\n')
    expect(extractNewsletterInsights(big).length).toBeLessThanOrEqual(2000)
  })
})

/* --------------------- ticker chart via the workshop -------------------- */

describe('ticker chart codegen (workshop-safe)', () => {
  it('bakes the data in and passes the workshop gate', () => {
    const code = buildTickerChartCode('RELIANCE', [
      { symbol: 'RELIANCE', price: 2930.1, changePct: 1.2 },
      { symbol: 'TCS', price: 4102.3, changePct: -0.4 },
    ])
    expect(code).toContain('2930.1')
    expect(code).toContain('RELIANCE')
    expect(gateWorkshopCode(code).ok).toBe(true)
  })

  it('the generated chart never needs the network or env', () => {
    const code = buildTickerChartCode('X', [{ symbol: 'X', price: 1, changePct: 0 }])
    expect(code).not.toMatch(/fetch|XMLHttpRequest|process\.env|require\(/)
  })

  it('escapes the symbol into the generated JS', () => {
    const code = buildTickerChartCode("RELI'; process.exit(1)", [{ symbol: 'X', price: 1, changePct: 0 }])
    // The hostile symbol lands inside a JS string literal, never bare code.
    expect(code).toContain('const SYMBOL = "RELI\'; process.exit(1)";')
    expect(gateWorkshopCode(code).ok).toBe(true)
  })
})

/* ------------------------------ API routes ------------------------------ */

const AUTH_REQ = () => new Request('https://hirealpha.chat/api/vault', { headers: { authorization: 'Bearer sess' } })
const authedDeps = (userId = USER) => ({
  resolveUser: async () => ({ id: userId, persona: 'coworker' }),
  internalOk: () => true,
  key: KEY_A,
  launch: async () => ({ ok: true as const, content: '' }),
})

describe('vault API routes', () => {
  it('401s without a session', async () => {
    const depsNoAuth = { resolveUser: async () => null, internalOk: () => true, launch: async () => ({ ok: true as const, content: '' }) }
    const res = await handleVaultApi(new Request('https://hirealpha.chat/api/vault'), fakeSql().sql, depsNoAuth)
    expect(res?.status).toBe(401)
  })

  it('GET /api/vault returns masked entries', async () => {
    const { sql } = fakeSql(() => [
      { id: 'e1', persona: 'coworker', portal: 'portal.nseindia.com', origin: 'https://portal.nseindia.com', secret_encrypted: encryptSecret('hunter2!', KEY_A), created_at: new Date(), last_used_at: null },
    ])
    const res = await handleVaultApi(AUTH_REQ(), sql, authedDeps())
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { entries: Array<{ masked: string }> }
    expect(body.entries.length).toBe(1)
    expect(JSON.stringify(body)).not.toContain('hunter2!')
  })

  it('POST /api/vault stores an encrypted entry', async () => {
    const { sql, queries } = fakeSql()
    const req = new Request('https://hirealpha.chat/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sess' },
      body: JSON.stringify({ portal: 'https://portal.nseindia.com', secret: 'hunter2!', persona: 'coworker' }),
    })
    const res = await handleVaultApi(req, sql, authedDeps())
    expect(res?.status).toBe(200)
    expect(JSON.stringify(queries)).not.toContain('hunter2!')
  })

  it('POST /api/vault rejects junk input with 400', async () => {
    const { sql } = fakeSql()
    const req = new Request('https://hirealpha.chat/api/vault', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sess' },
      body: JSON.stringify({ portal: 'http://insecure.com', secret: 'x' }),
    })
    const res = await handleVaultApi(req, sql, authedDeps())
    expect(res?.status).toBe(400)
  })

  it('DELETE /api/vault removes only the owner’s entry', async () => {
    const { sql, queries } = fakeSql((text) => (/DELETE FROM hire_vault_entries/i.test(text) ? [{ id: 'e1' }] : []))
    const req = new Request('https://hirealpha.chat/api/vault?id=e1', { method: 'DELETE', headers: { authorization: 'Bearer sess' } })
    const res = await handleVaultApi(req, sql, authedDeps())
    expect(res?.status).toBe(200)
    expect(queries.some((q) => /DELETE FROM hire_vault_entries/i.test(q.text))).toBe(true)
  })

  it('POST /api/browser/approvals records the decision', async () => {
    const { sql, queries } = fakeSql((text) => (/UPDATE hire_browser_approvals/i.test(text) ? [{ id: 'r1' }] : []))
    const req = new Request('https://hirealpha.chat/api/browser/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sess' },
      body: JSON.stringify({ requestId: 'r1', decision: 'deny' }),
    })
    const res = await handleVaultApi(req, sql, authedDeps())
    expect(res?.status).toBe(200)
    expect(queries.some((q) => /UPDATE hire_browser_approvals/i.test(q.text))).toBe(true)
  })

  it('internal browser task requires the internal key', async () => {
    const noKey = { ...authedDeps(), internalOk: () => false }
    const req = new Request('https://hirealpha.chat/api/internal/browser/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: USER, persona: 'coworker', requestId: 'r1', kind: 'ticker', url: NSE }),
    })
    const res = await handleVaultApi(req, fakeSql().sql, noKey)
    expect(res?.status).toBe(401)
  })

  it('internal browser task runs end-to-end for a bot', async () => {
    const { sql } = sqlForTask({ approval: 'approved', secret: 'hunter2!' })
    const req = new Request('https://hirealpha.chat/api/internal/browser/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: JSON.stringify({ userId: USER, persona: 'coworker', requestId: 'r1', kind: 'ticker', url: NSE }),
    })
    const d = deps()
    const res = await handleVaultApi(req, sql, { ...authedDeps(), launch: d.launch })
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; kind: string }
    expect(body.ok).toBe(true)
    expect(body.kind).toBe('ticker')
    expect(d.launched.length).toBe(1)
  })

  it('unknown vault route passes through (null, not 404-own)', async () => {
    const res = await handleVaultApi(new Request('https://hirealpha.chat/api/other'), fakeSql().sql, authedDeps())
    expect(res).toBeNull()
  })
})