import type { SQL } from 'bun'
import { json, appBase } from '../utils/http'
import { isPersona } from '../personas'
import { getUserByEmail, getUserByPhone } from '../db/users'
import { verifySessionToken } from '../auth/session'
import {
  getBrowserJob,
  verifySessionViewToken,
  resumeBrowserHandoff,
  answerBrowserHandoff,
  queuePendingText,
  findAwaitingQuestionJob,
} from '../browserJobs'
import { decideBrowserApproval } from '../browserVault'

export function appendSessionTokenToProxyAssets(html: string, proxyPrefix: string, token: string): string {
  if (!token) return html
  const escapedPrefix = proxyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const encodedToken = encodeURIComponent(token)
  // The provider page embeds some URLs as \"...\" (backslash-escaped quotes),
  // so the delimiter is an optional run of backslashes plus the quote — the
  // back-reference keeps the closing delimiter identical to the opening one.
  return html.replace(
    new RegExp(`((?:\\\\+)?["'])(${escapedPrefix}/[^"']+)\\1`, 'g'),
    (_match, quote: string, assetUrl: string) =>
      `${quote}${assetUrl}${assetUrl.includes('?') ? '&' : '?'}token=${encodedToken}${quote}`,
  )
}

export type BrowserRouteDeps = {
  internalOk: (req: Request) => boolean
}

export async function handleBrowserRoutes(
  req: Request,
  sql: SQL | null | undefined,
  deps: BrowserRouteDeps,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  // Live Computer Proxy: proxies provider live view (Kernel port 8443) over standard 443 HTTPS
  // so mobile browsers and corporate firewalls can open the live view.
  if (path.startsWith('/api/computer/live-proxy/')) {
    const jobId = path.slice('/api/computer/live-proxy/'.length).split('/')[0]
    // getBrowserJob feeds the uuid to Postgres; a malformed id throws 22P02
    // and the route answers 500 for what is simply "no such session".
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
      return new Response('Live view unavailable or session ended.', { status: 404 })
    }
    if (!jobId) return json({ error: 'Job ID required' }, 400)
    if (!sql) return json({ error: 'Database unavailable' }, 503)

    const job = await getBrowserJob(sql, jobId)
    if (!job || !job.live_view_url) return new Response('Live view unavailable or session ended.', { status: 404 })

    // The view token only rides the first request. The SPA then pulls its own
    // bundles with ?jwt=<provider token> and no ?token=, so the HTML response
    // plants an ha_live_<jobId> cookie scoped to this proxy path. The websocket
    // upgrade in web-server.ts already trusts that cookie; without the same
    // fallback here every asset answers 403 and the live view boots blank.
    const liveCookie = (req.headers.get('cookie') || '').split(';').map((v) => v.trim())
      .find((v) => v.startsWith(`ha_live_${jobId}=`))?.slice(`ha_live_${jobId}=`.length)
    const token = url.searchParams.get('token') || url.searchParams.get('t')
      || req.headers.get('x-session-token') || liveCookie
    let isAuthorized = false
    if (token && verifySessionViewToken(jobId, job.user_id, token)) {
      isAuthorized = true
    } else {
      const cookie = (req.headers.get('cookie') || '').split(';').map((v) => v.trim()).find((v) => v.startsWith('hirealpha_session='))?.slice('hirealpha_session='.length)
      const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      const explicitSession = url.searchParams.get('s') || bearer || cookie
      if (explicitSession) {
        const ses = verifySessionToken(explicitSession)
        if (ses) {
          const user = await getUserByEmail(sql, ses.email)
          if (user && user.id === job.user_id) isAuthorized = true
        }
      }
    }
    if (!isAuthorized) return new Response('Unauthorized.', { status: 403 })

    try {
      const rest = path.slice('/api/computer/live-proxy/'.length)
      const parts = rest.split('/').filter(Boolean)
      const subPath = parts.slice(1).join('/')

      let targetUrl = job.live_view_url
      if (subPath) {
        // Sub-paths are origin-root relative: the HTML rewrite (below) and the
        // websocket upgrade (web-server) both map proxy sub-paths onto the
        // provider origin root. Preserve the search query (e.g. ?jwt=...).
        const baseOrigin = new URL(job.live_view_url).origin
        const search = url.search || ''
        targetUrl = `${baseOrigin}/${subPath}${search}`
      }

      const upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': req.headers.get('user-agent') || 'HireAlpha/1.0',
          Accept: req.headers.get('accept') || '*/*',
        },
      })
      const headers = new Headers(upstream.headers)
      headers.delete('content-security-policy')
      headers.delete('x-frame-options')
      headers.set('access-control-allow-origin', '*')

      const contentType = upstream.headers.get('content-type') || ''
      if (contentType.includes('text/html')) {
        let html = await upstream.text()
        const proxyPrefix = `/api/computer/live-proxy/${encodeURIComponent(jobId)}`
        const proxyBase = `${proxyPrefix}/`
        if (html.includes('<head>')) {
          html = html.replace('<head>', `<head><base href="${proxyBase}">`)
        } else if (html.includes('<head ')) {
          html = html.replace(/<head\b[^>]*>/, `$&<base href="${proxyBase}">`)
        }
        // Rewrite root-relative URLs (/browser/live/...) to point to our proxy
        html = html.replaceAll('="/browser/live/', `="${proxyPrefix}/browser/live/`)
        html = html.replaceAll("='/browser/live/", `='${proxyPrefix}/browser/live/`)
        html = html.replaceAll('\\"/browser/live/', `\\"${proxyPrefix}/browser/live/`)

        if (token) {
          html = appendSessionTokenToProxyAssets(html, proxyPrefix, token)
        }

        try {
          const upstreamHost = new URL(job.live_view_url).host
          const host = req.headers.get('host') || url.host
          const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
          const isSecure = proto === 'https'
          const proxyWsOrigin = `${isSecure ? 'wss' : 'ws'}://${host}${proxyPrefix}`
          const proxyHttpOrigin = `${isSecure ? 'https' : 'http'}://${host}${proxyPrefix}`
          html = html.split(`wss://${upstreamHost}`).join(proxyWsOrigin)
          html = html.split(`ws://${upstreamHost}`).join(proxyWsOrigin)
          html = html.split(`https://${upstreamHost}`).join(proxyHttpOrigin)
          html = html.split(`http://${upstreamHost}`).join(proxyHttpOrigin)
        } catch { /* unparseable upstream URL: serve as-is */ }
        const headersOut = new Headers(headers)
        if (token) {
          headersOut.append('set-cookie', `ha_live_${jobId}=${encodeURIComponent(token)}; Path=${proxyPrefix}; HttpOnly; SameSite=None; Secure; Max-Age=86400`)
        }
        return new Response(html, { status: upstream.status, headers: headersOut })
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      })
    } catch (err) {
      return new Response(`Unable to reach provider live stream: ${err instanceof Error ? err.message : String(err)}`, { status: 502 })
    }
  }

  // Live Computer Sessions: secured view for the user who initiated the session
  if (path.startsWith('/api/computer/session/')) {
    const sub = path.slice('/api/computer/session/'.length)
    const parts = sub.split('/').filter(Boolean)
    const jobId = parts[0]
    const action = parts[1] || ''
    if (!jobId) return json({ error: 'Session ID required' }, 400)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
      return json({ error: 'Session not found' }, 404)
    }
    if (!sql) return json({ error: 'Database unavailable' }, 503)

    const job = await getBrowserJob(sql, jobId)
    if (!job) return json({ error: 'Session not found' }, 404)

    // Security check: either signed token query param/header, or logged in owner
    const token = url.searchParams.get('token') || url.searchParams.get('t') || req.headers.get('x-session-token')
    let isAuthorized = false

    if (token && verifySessionViewToken(jobId, job.user_id, token)) {
      isAuthorized = true
    } else {
      const cookie = (req.headers.get('cookie') || '').split(';').map((v) => v.trim()).find((v) => v.startsWith('hirealpha_session='))?.slice('hirealpha_session='.length)
      const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      const explicitSession = url.searchParams.get('s') || bearer || cookie
      if (explicitSession) {
        const ses = verifySessionToken(explicitSession)
        if (ses) {
          const user = await getUserByEmail(sql, ses.email)
          if (user && user.id === job.user_id) {
            isAuthorized = true
          }
        }
      }
    }

    if (!isAuthorized) {
      return json({ error: 'Unauthorized: Only the user who initiated this session can view it', code: 'forbidden' }, 403)
    }

    if (action === 'cancel' && req.method === 'POST') {
      await sql`UPDATE hire_browser_jobs SET status = 'failed', error = 'Cancelled by user', finished_at = now() WHERE id = ${jobId} AND status IN ('pending', 'running', 'waiting')`
      return json({ ok: true, cancelled: true })
    }

    if (action === 'approve' && req.method === 'POST') {
      if (!job.approval_id) return json({ error: 'This session has no approval request.' }, 409)
      const approved = await decideBrowserApproval(sql, job.user_id, job.approval_id, 'approve')
      if (!approved) return json({ error: 'This permission was already used or expired.' }, 409)
      return json({ ok: true, approved: true })
    }

    if (action === 'resume' && req.method === 'POST') {
      if (job.handoff_kind === 'payment') {
        return json({ error: 'This task continues automatically after Link confirms approval.' }, 409)
      }
      const resumed = await resumeBrowserHandoff(sql, jobId)
      return resumed ? json({ ok: true, resumed: true }) : json({ error: 'This task is not waiting for input.' }, 409)
    }

    if (action === 'answer' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { text?: string }
      const text = String(body.text || '').trim()
      if (!text) return json({ error: 'Type an answer first.' }, 400)
      const resumed = await answerBrowserHandoff(sql, jobId, text)
      if (resumed) return json({ ok: true, resumed: true })
      // Not a question handoff — the run is live or a takeover is in progress.
      // Relay the text to the loop, which types it into the focused field;
      // the streamed browser cannot raise the phone keyboard itself.
      const queued = await queuePendingText(sql, jobId, text)
      return queued
        ? json({ ok: true, queued: true })
        : json({ error: 'This task is not waiting for an answer.' }, 409)
    }

    if (action) return json({ error: 'Unknown computer session action.' }, 404)

    const providerLiveView = job.live_view_url?.trim() || ''
    const configuredStream = process.env.BROWSER_USE_STREAM_URL || (process.env.BROWSER_USE_DOMAIN ? `https://${process.env.BROWSER_USE_DOMAIN}/vnc.html` : '')
    const streamBase = configuredStream.replace('{sessionId}', encodeURIComponent(jobId))
    const vncPassword = process.env.CHROME_VNC_PASSWORD || ''
    const joiner = streamBase.includes('?') ? '&' : '?'
    const fallbackStream = streamBase ? `${streamBase}${joiner}autoconnect=true&resize=scale&reconnect=true${vncPassword ? `&password=${encodeURIComponent(vncPassword)}` : ''}` : ''

    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : ''
    const proxyStreamUrl = providerLiveView
      ? `${appBase(req)}/api/computer/live-proxy/${encodeURIComponent(jobId)}${tokenParam}`
      : null
    const directStreamUrl = providerLiveView || null
    const streamUrl = directStreamUrl || fallbackStream
    const assignedRows = (await sql`
      SELECT assigned_phone AS "assignedPhone"
      FROM hire_users
      WHERE id = ${job.user_id}
      LIMIT 1
    `) as unknown as Array<{ assignedPhone?: string | null }>
    const assignedPhone = String(assignedRows[0]?.assignedPhone || '').trim()
    const returnToMessagesUrl = assignedPhone ? `sms:${assignedPhone}` : 'sms:'

    return json({
      ok: true,
      session: {
        id: job.id,
        status: job.status,
        kind: job.kind,
        url: job.url,
        goal: job.goal,
        attempts: job.attempts,
        result: job.result,
        error: job.error,
        streamUrl: ['running', 'waiting'].includes(job.status) ? streamUrl : null,
        directStreamUrl: ['running', 'waiting'].includes(job.status) ? directStreamUrl : null,
        proxyStreamUrl: ['running', 'waiting'].includes(job.status) ? proxyStreamUrl : null,
        screenshotDataUrl: job.last_screenshot
          ? (job.last_screenshot.startsWith('data:') ? job.last_screenshot : `data:image/jpeg;base64,${job.last_screenshot}`)
          : null,
        currentUrl: job.current_url || job.url,
        steps: job.activity?.length
          ? job.activity
          : (Array.isArray(job.steps) ? job.steps : []).map((step) => {
              const s2 = (step || {}) as { action?: string; kind?: string }
              return { action: String(s2.action || s2.kind || 'step') }
            }),
        handoffKind: job.handoff_kind,
        handoffMessage: job.handoff_message,
        handoffAt: job.handoff_at,
        paymentUrl: job.handoff_kind === 'payment' && job.spend_request_id
          ? `${appBase(req)}/api/payments/spend/approve?id=${encodeURIComponent(job.spend_request_id)}`
          : null,
        returnToMessagesUrl,
      },
    })
  }

  if (path === '/api/internal/browser/last' && req.method === 'GET') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    if (!sql) return json({ error: 'Database unavailable' }, 503)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const rows = (await sql`
      SELECT id, persona, url, goal, status, result, error, current_url, handoff_kind, handoff_message,
             created_at, updated_at
      FROM hire_browser_jobs
      WHERE user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 1
    `) as Array<Record<string, unknown>>
    const row = rows[0]
    if (!row) return json({ run: null })
    let host = String(row.url || '')
    try { host = new URL(host).hostname.replace(/^www\./, '') } catch { /* keep the raw url */ }
    return json({
      run: {
        id: row.id,
        persona: row.persona,
        host,
        goal: row.goal ? String(row.goal).slice(0, 240) : '',
        status: row.status,
        outcome: row.result ? String(row.result).slice(0, 300) : row.error ? String(row.error).slice(0, 300) : null,
        waitingOn: row.handoff_kind ? { kind: row.handoff_kind, message: row.handoff_message ? String(row.handoff_message).slice(0, 240) : '' } : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    })
  }

  if (path === '/api/internal/browser/awaiting' && req.method === 'GET') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    if (!sql) return json({ error: 'Database unavailable' }, 503)
    const phone = url.searchParams.get('phone') || ''
    if (!phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ waiting: false })
    const job = await findAwaitingQuestionJob(sql, user.id)
    return json({ waiting: Boolean(job), question: job?.handoff_message ?? null, jobId: job?.id ?? null })
  }

  if (path === '/api/internal/browser/answer' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    if (!sql) return json({ error: 'Database unavailable' }, 503)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; text?: string; cancel?: boolean }
    if (!body.phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ ok: true, answered: false })
    const job = await findAwaitingQuestionJob(sql, user.id)
    if (!job) return json({ ok: true, answered: false })
    if (body.cancel) {
      const rows = (await sql`
        UPDATE hire_browser_jobs
        SET status = 'failed', error = 'The user cancelled this task.', finished_at = now()
        WHERE id = ${job.id} AND status = 'waiting' AND handoff_kind = 'question'
        RETURNING id
      `) as Array<{ id: string }>
      return json({ ok: true, answered: rows.length > 0, cancelled: true, jobId: job.id })
    }
    if (!body.text) return json({ error: 'text required' }, 400)
    const resumed = await answerBrowserHandoff(sql, job.id, body.text)
    return json({ ok: true, answered: resumed, jobId: job.id })
  }

  return null
}
