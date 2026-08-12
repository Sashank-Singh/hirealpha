import { describe, expect, test, beforeEach } from 'bun:test'
import { decryptToken, encryptToken, generateMasterKey, loadMasterKey, redactSecrets } from '../src/crypto/tokens'
import { MemoryStore } from '../src/db/memory'
import { ConnectorService } from '../src/oauth/service'
import { createApp } from '../src/api/routes'
import { defaultEnabledFor, isHardDenied } from '../src/permissions'
import type { Service } from '../src/types'

function testKey() {
  process.env.TOKEN_ENCRYPTION_KEY = generateMasterKey()
  return loadMasterKey()
}

function mockFetchFactory(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return handler(url, init)
  }) as typeof fetch
}

describe('token crypto', () => {
  test('encrypt/decrypt roundtrip', () => {
    const key = testKey()
    const blob = encryptToken('ya29.secret-access', key)
    expect(blob.startsWith('v1:')).toBe(true)
    expect(blob.includes('ya29')).toBe(false)
    expect(decryptToken(blob, key)).toBe('ya29.secret-access')
  })

  test('redactSecrets strips token-like strings', () => {
    const s = redactSecrets('token=ya29.abcdefGHIJKLMNOPQRSTUVWXYZ012345 and xoxb-123')
    expect(s).not.toContain('ya29')
    expect(s).toContain('[REDACTED]')
  })
})

describe('permission defaults', () => {
  test('Friend never gets Stripe by default or hard rule', () => {
    expect(defaultEnabledFor('friend', 'stripe')).toBe(false)
    expect(isHardDenied('friend', 'stripe')).toBe(true)
    expect(defaultEnabledFor('cofounder', 'stripe')).toBe(true)
  })

  test('Coworker gets slack; Friend does not', () => {
    expect(defaultEnabledFor('coworker', 'slack')).toBe(true)
    expect(defaultEnabledFor('friend', 'slack')).toBe(false)
  })
})

describe('ConnectorService OAuth + permissions', () => {
  let store: MemoryStore
  let service: ConnectorService
  let masterKey: Buffer
  let clock: number

  beforeEach(() => {
    masterKey = testKey()
    store = new MemoryStore()
    clock = Date.now()
    service = new ConnectorService({
      store,
      masterKey,
      now: () => new Date(clock),
      credentials: () => ({
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'http://localhost/oauth/callback/gmail',
      }),
      fetchFn: mockFetchFactory(() =>
        Response.json({
          access_token: 'access-AAA',
          refresh_token: 'refresh-BBB',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
        }),
      ),
      appBaseUrl: 'http://app.test',
    })
  })

  test('connect flow stores encrypted token and seeds permissions', async () => {
    const user = await store.createUser({ phoneNumber: '+15551212', email: 'a@b.com' })
    const { state } = await service.startConnect({ userId: user.id, service: 'gmail' })
    const { connectedAccountId } = await service.handleCallback({
      service: 'gmail',
      code: 'auth-code',
      state,
    })

    const account = await store.getConnectedAccount(connectedAccountId)
    expect(account?.status).toBe('active')
    expect(account?.accessTokenEnc.includes('access-AAA')).toBe(false)
    expect(decryptToken(account!.accessTokenEnc, masterKey)).toBe('access-AAA')

    const dto = await service.listConnections(user.id)
    expect(JSON.stringify(dto)).not.toContain('access-AAA')
    expect(JSON.stringify(dto)).not.toContain('refresh-BBB')

    const coworker = dto[0]!.personas.find((p) => p.persona === 'coworker')
    const friend = dto[0]!.personas.find((p) => p.persona === 'friend')
    expect(coworker?.enabled).toBe(true)
    expect(friend?.enabled).toBe(false)
  })

  test('callback rejects invalid state', async () => {
    await expect(
      service.handleCallback({ service: 'gmail', code: 'x', state: 'nope' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  test('callback rejects expired state', async () => {
    const user = await store.createUser({ phoneNumber: '+15550001' })
    const { state } = await service.startConnect({ userId: user.id, service: 'gmail' })
    clock += 11 * 60 * 1000
    await expect(
      service.handleCallback({ service: 'gmail', code: 'x', state }),
    ).rejects.toMatchObject({ code: 'EXPIRED_STATE' })
  })

  test('refresh rotates token; failure marks error without throwing through getActiveTools', async () => {
    const user = await store.createUser({ phoneNumber: '+15550002' })
    const { state } = await service.startConnect({ userId: user.id, service: 'gmail' })
    await service.handleCallback({ service: 'gmail', code: 'c', state })

    // Force near-expiry
    const acct = (await store.listConnectedAccounts(user.id))[0]!
    await store.updateConnectedAccount(acct.id, {
      tokenExpiresAt: new Date(clock + 60_000),
    })

    let calls = 0
    service = new ConnectorService({
      store,
      masterKey,
      now: () => new Date(clock),
      credentials: () => ({
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'http://localhost/cb',
      }),
      fetchFn: mockFetchFactory(() => {
        calls++
        if (calls === 1) {
          return Response.json({
            access_token: 'access-NEW',
            refresh_token: 'refresh-BBB',
            expires_in: 3600,
            scope: 'gmail.readonly',
          })
        }
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }),
    })

    const refreshed = await service.refreshAccount(await store.getConnectedAccount(acct.id) as never)
    expect(decryptToken(refreshed.accessTokenEnc, masterKey)).toBe('access-NEW')

    await store.updateConnectedAccount(acct.id, {
      tokenExpiresAt: new Date(clock + 60_000),
    })
    await expect(service.refreshAccount((await store.getConnectedAccount(acct.id))!)).rejects.toMatchObject({
      code: 'REFRESH_FAILED',
    })
    expect((await store.getConnectedAccount(acct.id))!.status).toBe('error')

    // Live path: getActiveTools skips errored / failed refresh gracefully
    await store.updateConnectedAccount(acct.id, {
      status: 'active',
      tokenExpiresAt: new Date(clock + 60_000),
    })
    const tools = await service.getActiveToolsForPersona(user.id, 'coworker')
    expect(tools.length).toBe(0)
    expect((await store.getConnectedAccount(acct.id))!.status).toBe('error')
  })

  test('persona A cannot use connector disabled for it', async () => {
    const user = await store.createUser({ phoneNumber: '+15550003' })
    const { state } = await service.startConnect({ userId: user.id, service: 'gmail' })
    const { connectedAccountId } = await service.handleCallback({
      service: 'gmail',
      code: 'c',
      state,
    })

    const coworkerTools = await service.getActiveToolsForPersona(user.id, 'coworker')
    expect(coworkerTools.map((t) => t.service)).toContain('gmail')

    const friendTools = await service.getActiveToolsForPersona(user.id, 'friend')
    expect(friendTools.map((t) => t.service)).not.toContain('gmail')

    await service.patchPermissions(user.id, 'coworker', [
      { connectedAccountId, enabled: false },
    ])
    const after = await service.getActiveToolsForPersona(user.id, 'coworker')
    expect(after.length).toBe(0)
  })

  test('cannot enable Stripe for Friend', async () => {
    const user = await store.createUser({ phoneNumber: '+15550004' })
    // Fake a stripe connection by seeding via service with stripe mock
    const stripeService = new ConnectorService({
      store,
      masterKey,
      credentials: () => ({
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'http://localhost/oauth/callback/stripe',
      }),
      fetchFn: mockFetchFactory(() =>
        Response.json({
          access_token: 'sk_test_looks_like_secret_but_oauth',
          refresh_token: 'rt',
          expires_in: 3600,
          scope: 'read_only',
          stripe_user_id: 'acct_1',
        }),
      ),
    })
    const { state } = await stripeService.startConnect({ userId: user.id, service: 'stripe' })
    const { connectedAccountId } = await stripeService.handleCallback({
      service: 'stripe',
      code: 'c',
      state,
    })

    const dto = await stripeService.listConnections(user.id)
    expect(dto[0]!.personas.find((p) => p.persona === 'friend')!.enabled).toBe(false)

    await expect(
      stripeService.patchPermissions(user.id, 'friend', [
        { connectedAccountId, enabled: true },
      ]),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  test('disconnect removes tools from all personas', async () => {
    const user = await store.createUser({ phoneNumber: '+15550005' })
    const { state } = await service.startConnect({ userId: user.id, service: 'gmail' })
    const { connectedAccountId } = await service.handleCallback({
      service: 'gmail',
      code: 'c',
      state,
    })
    expect((await service.getActiveToolsForPersona(user.id, 'coworker')).length).toBe(1)
    await service.disconnect(connectedAccountId)
    expect((await service.getActiveToolsForPersona(user.id, 'coworker')).length).toBe(0)
    expect((await service.getActiveToolsForPersona(user.id, 'cofounder')).length).toBe(0)
  })

  test('write tools require confirmation and log it', async () => {
    const user = await store.createUser({ phoneNumber: '+15550006' })
    const { state } = await service.startConnect({ userId: user.id, service: 'gmail' })
    const { connectedAccountId } = await service.handleCallback({
      service: 'gmail',
      code: 'c',
      state,
    })

    const first = await service.authorizeToolCall({
      userId: user.id,
      persona: 'coworker',
      toolName: 'gmail.send',
      connectedAccountId,
      inputSummary: 'Send email with token ya29.shouldRedactABCDEFGHIJKLMNOP',
    })
    expect(first.allowed).toBe(false)
    if (first.allowed) throw new Error('expected deny')
    expect(first.reason).toBe('confirmation_required')
    expect(first.confirmationKey).toBeTruthy()

    const logs = await service.listActivity(user.id)
    expect(logs.items[0]!.status).toBe('pending_confirmation')
    expect(logs.items[0]!.inputSummary).not.toContain('ya29')

    const second = await service.authorizeToolCall({
      userId: user.id,
      persona: 'coworker',
      toolName: 'gmail.send',
      connectedAccountId,
      inputSummary: 'Send email',
      confirmed: true,
      confirmationKey: first.confirmationKey,
    })
    expect(second.allowed).toBe(true)
  })
})

describe('HTTP API contract', () => {
  test('connections endpoint never returns tokens', async () => {
    const masterKey = testKey()
    const store = new MemoryStore()
    const service = new ConnectorService({
      store,
      masterKey,
      credentials: (s: Service) => ({
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: `http://localhost/oauth/callback/${s}`,
      }),
      fetchFn: mockFetchFactory(() =>
        Response.json({
          access_token: 'SUPER_SECRET_TOKEN_VALUE_1234567890',
          refresh_token: 'SUPER_SECRET_REFRESH_1234567890',
          expires_in: 3600,
          scope: 'read',
        }),
      ),
    })
    const app = createApp(service)
    const user = await store.createUser({ phoneNumber: '+15550999' })
    const { state } = await service.startConnect({ userId: user.id, service: 'notion' })
    await service.handleCallback({ service: 'notion', code: 'c', state })

    const res = await app.request(`http://test/users/${user.id}/connections`)
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).not.toContain('SUPER_SECRET')
    expect(body).toContain('notion')
  })

  test('invalid callback state returns 400', async () => {
    const masterKey = testKey()
    const service = new ConnectorService({
      store: new MemoryStore(),
      masterKey,
      credentials: () => ({ clientId: 'a', clientSecret: 'b', redirectUri: 'http://x' }),
    })
    const app = createApp(service)
    const res = await app.request('http://test/oauth/callback/gmail?code=x&state=bad')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('INVALID_STATE')
  })
})
