/**
 * PostgresStore tests — requires a real Postgres:
 *   createdb hirealpha_connectors_test
 *   DATABASE_URL=postgres://localhost/hirealpha_connectors_test bun test tests/postgres.test.ts
 */
import { beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { generateMasterKey, loadMasterKey } from '../src/crypto/tokens'
import { PostgresStore } from '../src/db/postgres'
import { ConnectorService } from '../src/oauth/service'
import { createApp } from '../src/api/routes'

const url = process.env.DATABASE_URL
const run = !!url

describe.skipIf(!run)('PostgresStore', () => {
  let store: PostgresStore
  let masterKey: Buffer

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = generateMasterKey()
    masterKey = loadMasterKey()
    store = new PostgresStore(url!)
    // Apply schema (idempotent-ish for empty test DB)
    const schema = await Bun.file(new URL('../sql/migrations/001_initial.sql', import.meta.url)).text()
    try {
      await store.sql.unsafe(schema)
    } catch {
      // types may already exist
    }
    await store.sql`delete from tool_call_log`
    await store.sql`delete from persona_connector_permissions`
    await store.sql`delete from connected_accounts`
    await store.sql`delete from oauth_state`
    await store.sql`delete from users`
  })

  afterAll(async () => {
    await store.close()
  })

  test('completeOAuthConnect is transactional and encrypted', async () => {
    const service = new ConnectorService({
      store,
      masterKey,
      credentials: () => ({
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'http://localhost/oauth/callback/gmail',
      }),
      fetchFn: (async () =>
        Response.json({
          access_token: 'pg-access-secret-token-value',
          refresh_token: 'pg-refresh-secret-token-value',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        })) as typeof fetch,
    })

    const user = await store.createUser({ phoneNumber: '+15551112222', email: 'pg@test.com' })
    const { state } = await service.startConnect({ userId: user.id, service: 'gmail' })
    const { connectedAccountId } = await service.handleCallback({
      service: 'gmail',
      code: 'code',
      state,
    })

    const account = await store.getConnectedAccount(connectedAccountId)
    expect(account?.accessTokenEnc.includes('pg-access')).toBe(false)

    const dto = await service.listConnections(user.id)
    expect(JSON.stringify(dto)).not.toContain('pg-access')
    expect(dto[0]?.personas.find((p) => p.persona === 'coworker')?.enabled).toBe(true)

    const app = createApp(service)
    const res = await app.request(`http://test/users/${user.id}/connections`)
    expect(await res.text()).not.toContain('pg-access')
  })

  test('healthCheck passes', async () => {
    expect(await store.healthCheck()).toBe(true)
  })
})
