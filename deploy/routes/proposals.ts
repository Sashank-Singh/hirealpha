import type { SQL } from 'bun'
import { isPersona, type Persona } from '../personas'
import { json } from '../utils/http'
import { appBaseFromEnv } from '../billing/stripe'
import { parseSpokenWhen } from '../timezones'
import { getLinkStatus } from '../linkWallet'
import { requestBrowserApproval, decideBrowserApproval } from '../browserVault'
import { enqueueBrowserJob, generateSessionViewToken } from '../browserJobs'
import { createCapabilityGrant, decideCapabilityGrant } from '../../services/trust/capabilityGrants'
import { computeIdempotencyKey, withIdempotency } from '../utils/idempotency'

export interface ProposalRouteOptions {
  internalOk: (req: Request) => boolean
  livePayload: (sql: SQL, phone: string, persona: Persona) => Promise<any>
  gmailReplyMeta: (
    sql: SQL,
    userId: string,
    messageId: string,
  ) => Promise<{ to: string; subject: string; threadId: string; inReplyTo: string } | null>
}

export async function handleProposalRoutes(
  req: Request,
  sql: SQL,
  options: ProposalRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path !== '/api/internal/propose' || req.method !== 'POST') return null
  if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)

  const body = (await req.json().catch(() => ({}))) as {
    phone?: string
    persona?: string
    kind?: string
    to?: string
    subject?: string
    body?: string
    messageId?: string
    title?: string
    start?: string
    end?: string
    url?: string
    amount?: number
    idempotencyKey?: string
  }

  if (!body.phone || !body.persona || !isPersona(body.persona)) {
    return json({ error: 'phone and persona required' }, 400)
  }
  const persona: Persona = body.persona

  const live = await options.livePayload(sql, body.phone, persona)
  if (!live.found || !live.hired || !live.userId) return json({ ok: false, error: 'not hired' }, 404)
  const tz = live.timezone || 'America/Los_Angeles'

  const respond = (data: any, status = 200) => ({ status, data })

  const idempotencyKey =
    body.idempotencyKey ||
    req.headers.get('idempotency-key') ||
    req.headers.get('x-idempotency-key') ||
    computeIdempotencyKey('propose', {
      userId: live.userId,
      persona: persona,
      kind: body.kind,
      to: body.to,
      subject: body.subject || body.title,
      body: body.body,
      messageId: body.messageId,
      start: body.start,
      end: body.end,
      url: body.url,
      amount: body.amount,
    })

  const { result } = await withIdempotency(idempotencyKey, async () => {
    // Only the exact proposed operation is a duplicate. Subject-only matching
    // silently discarded distinct recipients and revisions with the same title.
    if (body.kind !== 'browser' && body.kind !== 'purchase') {
      const existing = (await sql`
        SELECT id, kind, version FROM hire_drafts
        WHERE user_id = ${live.userId} AND operation_key = ${idempotencyKey}
          AND status IN ('pending', 'sending', 'booking', 'outcome_unknown')
        LIMIT 1
      `) as Array<{ id: string; kind: string; version: number }>
      if (existing[0]) {
        return respond({ ok: true, id: existing[0].id, kind: existing[0].kind, version: existing[0].version, deduplicated: true }, 200)
      }
    }

    if (body.kind === 'browser') {
      const portal = String(body.url || '').trim()
      const goal = String(body.body || '').trim()
      if (!/^https:\/\//i.test(portal)) return respond({ ok: false, error: 'Browser task needs an https site URL.' }, 400)
      if (goal.length < 8) return respond({ ok: false, error: 'Browser task needs a real goal.' }, 400)

      let hostname = ''
      try {
        hostname = new URL(portal).hostname.replace(/^www\./, '').toLowerCase()
      } catch {}

      const isProtectedPortal =
        /\b(?:log ?in|sign ?in|signin|password|credentials|portal|student|grades?|tuition|banking|bank account|subscription)\b/i.test(goal) ||
        /\b(?:campusnet|csuohio|blackboard|canvas|amazon|netflix|chase|wellsfargo|bankofamerica|fidelity|vanguard|linkedin|github)\b/i.test(portal) ||
        /\.edu\b/i.test(portal) ||
        /\/login|\/signin|\/auth|\/account|\/portal/i.test(portal)

      let hostedVaultItem: { id: string; exact_origin: string; label: string } | null = null
      if (isProtectedPortal && hostname) {
        const parts = hostname.split('.')
        const rootDomain = parts.length >= 2 ? parts.slice(-2).join('.') : hostname

        const existingEntries = await sql`
          SELECT id, portal, origin FROM hire_vault_entries
          WHERE user_id = ${live.userId!}
        `.then((r) => r as Array<{ id: string; portal: string; origin: string }>).catch(() => [])

        const hasVault = existingEntries.some((e) => {
          const p = (e.portal || e.origin || '').toLowerCase()
          let entryHost = ''
          try {
            entryHost = new URL(p.startsWith('http') ? p : `https://${p}`).hostname.replace(/^www\./, '').toLowerCase()
          } catch {}
          return (
            p.includes(hostname) ||
            p.includes(rootDomain) ||
            (entryHost && (hostname.includes(entryHost) || entryHost.includes(hostname) || entryHost.includes(rootDomain) || rootDomain.includes(entryHost))) ||
            (hostname.includes('campusnet') && (p.includes('campusnet') || p.includes('csuohio')))
          )
        })

        const requestedOrigin = new URL(portal).origin.toLowerCase()
        const hostedItems = await sql`
          SELECT id, exact_origin, label FROM vault_items_v2
          WHERE user_id = ${live.userId!} AND revoked_at IS NULL AND ciphertext IS NOT NULL
        `.then((r) => r as Array<{ id: string; exact_origin: string; label: string }>).catch(() => [])
        hostedVaultItem = hostedItems.find((row) => row.exact_origin.toLowerCase() === requestedOrigin) ?? null
        const hasVaultItem = hasVault || Boolean(hostedVaultItem)

        if (!hasVault && !hasVaultItem) {
          return respond({
            ok: true,
            needsVault: true,
            portal,
            hostname,
          }, 200)
        }
      }
      const phoneE164 = live.phone || ''
      let approvalId: string | null = null
      let credential: {
        vaultItemId: string
        credentialCapabilityId: string
        credentialCapabilityDigest: string
        credentialTaskId: string
      } | null = null
      if (hostedVaultItem) {
        const created = await createCapabilityGrant(sql, {
          userId: live.userId!,
          taskId: crypto.randomUUID(),
          resourceType: 'credential',
          resourceId: hostedVaultItem.id,
          action: 'autofill',
          exactOrigin: hostedVaultItem.exact_origin,
          requestingAgent: 'alpha',
          purpose: goal.slice(0, 200),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        })
        const approved = await decideCapabilityGrant(sql, {
          id: created.id,
          userId: live.userId!,
          taskId: created.request.task_id,
          digest: created.digest,
          decision: 'approved',
        })
        if (!approved) return respond({ ok: false, error: 'Could not authorize this login task.' }, 409)
        credential = {
          vaultItemId: hostedVaultItem.id,
          credentialCapabilityId: created.id,
          credentialCapabilityDigest: created.digest,
          credentialTaskId: created.request.task_id,
        }
      } else {
        const approval = await requestBrowserApproval(sql, {
          userId: live.userId!, persona: persona, portal,
          purpose: goal.slice(0, 200),
        })
        if ('error' in approval) return respond({ ok: false, error: approval.error }, 400)
        const approved = await decideBrowserApproval(sql, live.userId!, approval.requestId, 'approve')
        if (!approved) return respond({ ok: false, error: 'Could not authorize this login task.' }, 409)
        approvalId = approval.requestId
      }
      const jobId = await enqueueBrowserJob(sql, {
        userId: live.userId!, persona: persona, phone: phoneE164,
        kind: 'task', url: portal, goal: goal.slice(0, 400),
        approvalId,
        ...(credential ?? {}),
      })
      const viewToken = generateSessionViewToken(jobId, live.userId!)
      const sessionUrl = `https://hirealpha.chat/computer/${jobId}?token=${viewToken}`
      return respond({
        ok: true,
        id: jobId,
        kind: 'browser',
        requestId: approvalId,
        origin: new URL(portal).origin,
        token: viewToken,
        sessionUrl,
      }, 200)
    }

    if (body.kind === 'purchase') {
      const item = String(body.title || body.subject || 'Item').slice(0, 140)
      const amount = Number(body.amount)
      const url = String(body.url || '')
      const cap = Number(process.env.PURCHASE_MAX_DOLLARS || 200)
      if (!Number.isFinite(amount) || amount < 1) return respond({ ok: false, error: 'Purchase needs a real price.' }, 400)
      if (amount > cap) return respond({ ok: false, error: `Above the ${cap}-dollar self-serve cap.` }, 400)
      let productUrl: URL
      try { productUrl = new URL(url) } catch { return respond({ ok: false, error: 'Purchase needs a real product URL.' }, 400) }
      if (productUrl.protocol !== 'https:' || productUrl.username || productUrl.password) {
        return respond({ ok: false, error: 'Purchase needs a secure product URL.' }, 400)
      }

      const link = await getLinkStatus(sql, live.userId!).catch(() => ({ connected: false, pending: false }))
      if (!link.connected) {
        const setupUrl = `${appBaseFromEnv()}/app?tab=settings&connect=payments`
        const pid = crypto.randomUUID()
        await sql`
          INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body, status)
          VALUES (${pid}, ${live.userId}, ${persona}, 'purchase', ${url}, ${item},
            ${JSON.stringify({ amount, setupUrl, needsSetup: true })}, 'pending')
        `
        return respond({ ok: true, id: pid, kind: 'purchase', needsSetup: true, setupUrl, paymentUrl: setupUrl, amount, item }, 200)
      }

      return respond({
        ok: false,
        error: 'Open this as a browser checkout so Alpha can independently verify the live cart before requesting payment approval.',
      }, 409)
    }

    const id = crypto.randomUUID()
    const kind = body.kind === 'event' || body.kind === 'reply' ? body.kind : 'email'
    let toAddr = String(body.to || '').slice(0, 200)
    let subject = String(body.subject || body.title || '').slice(0, 200)
    let text = String(body.body || '').slice(0, 8000)
    let threadId = ''
    let inReplyTo = ''
    let startAt = ''
    let endAt = ''

    if (kind === 'reply') {
      const meta = await options.gmailReplyMeta(sql, live.userId, String(body.messageId || '').trim())
      if (!meta) return respond({ ok: false, error: 'Could not load that mail to reply.' }, 400)
      toAddr = meta.to
      subject = meta.subject
      threadId = meta.threadId
      inReplyTo = meta.inReplyTo
      if (!text) return respond({ ok: false, error: 'Reply body required' }, 400)
    } else if (kind === 'event') {
      const start = parseSpokenWhen(String(body.start || ''), tz) || new Date(Date.now() + 60 * 60 * 1000)
      const endParsed = parseSpokenWhen(String(body.end || ''), tz)
      const end = endParsed && endParsed.getTime() > start.getTime()
        ? endParsed
        : new Date(start.getTime() + 30 * 60 * 1000)
      startAt = start.toISOString()
      endAt = end.toISOString()
      subject = String(body.title || subject || 'Hold').slice(0, 160)
    } else if (!toAddr || !subject) {
      return respond({ ok: false, error: 'to and subject required' }, 400)
    }

    await sql`
      INSERT INTO hire_drafts (
        id, user_id, persona, kind, to_addr, subject, body, thread_id, in_reply_to,
        start_at, end_at, operation_key, source_message_id, version
      )
      VALUES (
        ${id}, ${live.userId}, ${persona}, ${kind},
        ${toAddr}, ${subject}, ${text}, ${threadId}, ${inReplyTo}, ${startAt}, ${endAt},
        ${idempotencyKey}, ${String(body.messageId || '').slice(0, 200)}, 1
      )
    `
    return respond({ ok: true, id, version: 1, kind: kind === 'event' ? 'event' : 'email' }, 200)
  })

  return json(result.data, result.status)
}
