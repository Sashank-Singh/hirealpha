import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import type { ConnectorService } from '../oauth/service'
import type { ComposioGateway } from '../gateway/composio'
import { UI_OR_SERVICE_TO_COMPOSIO } from '../gateway/policy'
import { SERVICES, PERSONAS, ConnectorError, type Service, type Persona } from '../types'
import { RateLimiter } from './rateLimit'
import * as calendar from '../tools/googleCalendar'

function isService(v: string): v is Service {
  return (SERVICES as readonly string[]).includes(v)
}

function isPersona(v: string): v is Persona {
  return (PERSONAS as readonly string[]).includes(v)
}

function requireGateway(gateway: ComposioGateway | null): ComposioGateway {
  if (!gateway) {
    throw new ConnectorError(
      'Connector gateway is not configured. Set COMPOSIO_API_KEY on the connectors service.',
      'BAD_REQUEST',
    )
  }
  return gateway
}

export function createApp(
  service: ConnectorService,
  opts?: { corsOrigin?: string | string[]; gateway?: ComposioGateway | null },
) {
  const app = new Hono()
  const gateway = opts?.gateway ?? null
  const connectLimiter = new RateLimiter(20, 60_000)
  const refreshLimiter = new RateLimiter(30, 60_000)

  app.use(
    '*',
    cors({
      origin: opts?.corsOrigin ?? '*',
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  )

  app.onError((err, c) => {
    if (err instanceof ConnectorError) {
      const status =
        err.code === 'NOT_FOUND'
          ? 404
          : err.code === 'RATE_LIMITED'
            ? 429
            : err.code === 'INVALID_STATE' || err.code === 'EXPIRED_STATE'
              ? 400
              : err.code === 'PERMISSION_DENIED' || err.code === 'CONFIRMATION_REQUIRED'
                ? 403
                : 400
      return c.json({ error: err.code, message: err.message }, status)
    }
    if (err instanceof HTTPException) return err.getResponse()
    console.error('[connectors]', err instanceof Error ? err.message : 'unknown')
    return c.json({ error: 'INTERNAL', message: 'Internal error' }, 500)
  })

  app.get('/healthz', async (c) => {
    const health = await service.health()
    return c.json({ ...health, gateway: gateway ? 'composio' : null }, health.ok ? 200 : 503)
  })

  app.get('/health', async (c) => {
    const health = await service.health()
    return c.json({ ...health, gateway: gateway ? 'composio' : null }, health.ok ? 200 : 503)
  })

  /** One key unlocks the catalog (Composio). */
  app.get('/gateway/status', (c) => {
    return c.json({
      enabled: !!gateway,
      provider: gateway ? 'composio' : null,
    })
  })

  app.get('/gateway/catalog', async (c) => {
    const gw = requireGateway(gateway)
    const userId = c.req.query('user_id')
    if (!userId) throw new ConnectorError('user_id required', 'BAD_REQUEST')
    const personaQ = c.req.query('persona')
    const persona = personaQ && isPersona(personaQ) ? personaQ : null
    const limit = Number(c.req.query('limit') ?? '100')
    const category = c.req.query('category') ?? undefined
    const result = await gw.listCatalog({ userId, persona, limit, category })
    return c.json(result)
  })

  /** Redirect into Composio Connect Link for any toolkit slug. */
  app.get('/gateway/connect/:toolkit', async (c) => {
    const gw = requireGateway(gateway)
    const toolkit = c.req.param('toolkit')
    const userId = c.req.query('user_id')
    if (!userId) throw new ConnectorError('user_id required', 'BAD_REQUEST')
    if (!connectLimiter.check(`gateway-connect:${userId}`)) {
      throw new ConnectorError('Rate limited', 'RATE_LIMITED')
    }
    const personaQ = c.req.query('persona')
    const persona = personaQ && isPersona(personaQ) ? personaQ : null
    const redirectAfter =
      c.req.query('redirect_after') ??
      process.env.APP_BASE_URL ??
      'http://localhost:5173/app'
    const { redirectUrl } = await gw.startConnect({
      userId,
      toolkit,
      persona,
      callbackUrl: redirectAfter,
    })
    return c.redirect(redirectUrl, 302)
  })

  /** Convenience: map our UI/service ids (calendar, google_calendar) → Composio slug. */
  app.get('/gateway/connect-mapped/:service', async (c) => {
    const mapped = UI_OR_SERVICE_TO_COMPOSIO[c.req.param('service')]
    if (!mapped) throw new ConnectorError('Unknown service mapping', 'BAD_REQUEST')
    const qs = new URL(c.req.url).search
    return c.redirect(`/gateway/connect/${encodeURIComponent(mapped)}${qs}`, 302)
  })

  app.get('/gateway/users/:user_id/connections', async (c) => {
    const gw = requireGateway(gateway)
    const connections = await gw.listConnections(c.req.param('user_id'))
    return c.json({ connections })
  })

  app.post('/gateway/disconnect/:connected_account_id', async (c) => {
    const gw = requireGateway(gateway)
    await gw.disconnect(c.req.param('connected_account_id'))
    return c.json({ ok: true })
  })

  /** Internal: chat/agent layer fetches tools for a persona session. */
  app.post('/gateway/session', async (c) => {
    const gw = requireGateway(gateway)
    const body = await c.req.json<{
      userId?: string
      persona?: string
      mcp?: boolean
    }>()
    if (!body.userId) throw new ConnectorError('userId required', 'BAD_REQUEST')
    if (!body.persona || !isPersona(body.persona)) {
      throw new ConnectorError('persona required', 'BAD_REQUEST')
    }
    const session = await gw.createSession({
      userId: body.userId,
      persona: body.persona,
      mcp: !!body.mcp,
    })
    return c.json(session)
  })

  /** POST /users { email, phoneNumber? } → ensure user for OAuth */
  app.post('/users', async (c) => {
    const body = await c.req.json<{ email?: string; phoneNumber?: string }>()
    if (!body.email) throw new ConnectorError('email required', 'BAD_REQUEST')
    const user = await service.ensureUser({
      email: body.email,
      phoneNumber: body.phoneNumber,
    })
    return c.json({ user })
  })

  /** GET /connect/:service?user_id=&persona=&redirect_after= */
  app.get('/connect/:service', async (c) => {
    const serviceName = c.req.param('service')
    if (!isService(serviceName)) throw new ConnectorError('Unknown service', 'BAD_REQUEST')
    const userId = c.req.query('user_id')
    if (!userId) throw new ConnectorError('user_id required', 'BAD_REQUEST')
    if (!connectLimiter.check(`connect:${userId}`)) {
      throw new ConnectorError('Rate limited', 'RATE_LIMITED')
    }
    const personaQ = c.req.query('persona')
    const persona = personaQ && isPersona(personaQ) ? personaQ : null
    const { authorizeUrl } = await service.startConnect({
      userId,
      service: serviceName,
      persona,
      redirectAfter: c.req.query('redirect_after') ?? null,
    })
    return c.redirect(authorizeUrl, 302)
  })

  /** GET /oauth/callback/:service?code=&state= */
  app.get('/oauth/callback/:service', async (c) => {
    const serviceName = c.req.param('service')
    if (!isService(serviceName)) throw new ConnectorError('Unknown service', 'BAD_REQUEST')
    const code = c.req.query('code')
    const state = c.req.query('state')
    if (!code || !state) throw new ConnectorError('code and state required', 'BAD_REQUEST')
    const { redirectTo } = await service.handleCallback({
      service: serviceName,
      code,
      state,
    })
    return c.redirect(redirectTo, 302)
  })

  app.post('/disconnect/:connected_account_id', async (c) => {
    await service.disconnect(c.req.param('connected_account_id'))
    return c.json({ ok: true })
  })

  app.get('/users/:user_id/connections', async (c) => {
    const connections = await service.listConnections(c.req.param('user_id'))
    return c.json({ connections })
  })

  app.patch('/users/:user_id/personas/:persona/permissions', async (c) => {
    const persona = c.req.param('persona')
    if (!isPersona(persona)) throw new ConnectorError('Unknown persona', 'BAD_REQUEST')
    const body = await c.req.json<{
      updates: Array<{ connectedAccountId: string; enabled: boolean }>
    }>()
    if (!Array.isArray(body.updates)) {
      throw new ConnectorError('updates array required', 'BAD_REQUEST')
    }
    const connections = await service.patchPermissions(
      c.req.param('user_id'),
      persona,
      body.updates,
    )
    return c.json({ connections })
  })

  app.get('/users/:user_id/activity', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50')
    const cursor = c.req.query('cursor') ?? undefined
    const page = await service.listActivity(c.req.param('user_id'), { limit, cursor })
    return c.json(page)
  })

  app.post('/internal/refresh', async (c) => {
    if (!refreshLimiter.check('refresh:global')) {
      throw new ConnectorError('Rate limited', 'RATE_LIMITED')
    }
    const result = await service.refreshExpiring()
    await service.purgeExpiredStates()
    return c.json(result)
  })

  /** Calendar tools (internal / chat layer) */
  app.post('/tools/calendar/list_events', async (c) => {
    const body = await c.req.json<{
      userId: string
      persona: Persona
      connectedAccountId: string
      timeMin: string
      timeMax: string
      maxResults?: number
    }>()
    if (!isPersona(body.persona)) throw new ConnectorError('Unknown persona', 'BAD_REQUEST')
    const items = await calendar.listEvents(
      {
        connectors: service,
        userId: body.userId,
        persona: body.persona,
        connectedAccountId: body.connectedAccountId,
      },
      body,
    )
    return c.json({ items })
  })

  return app
}
