import { MemoryStore } from './db/memory'
import { PostgresStore, createPostgresStore } from './db/postgres'
import { generateMasterKey, loadMasterKey } from './crypto/tokens'
import { createApp } from './api/routes'
import { ConnectorService } from './oauth/service'
import { ComposioGateway } from './gateway/composio'
import type { Service } from './types'
import type { CredentialResolver } from './oauth/client'
import type { ConnectorStore } from './db/store'

export { ConnectorService } from './oauth/service'
export { MemoryStore } from './db/memory'
export { PostgresStore, createPostgresStore } from './db/postgres'
export type { ConnectorStore } from './db/store'
export { encryptToken, decryptToken, redactSecrets, generateMasterKey, loadMasterKey } from './crypto/tokens'
export { defaultEnabledFor, isHardDenied, isWriteTool } from './permissions'
export { PROVIDER_CONFIG } from './oauth/scopes'
export { createApp } from './api/routes'
export { ComposioGateway } from './gateway/composio'
export * as gatewayPolicy from './gateway/policy'
export * as googleCalendar from './tools/googleCalendar'
export * from './types'

function googleCred(service: Service): { clientId: string; clientSecret: string } | null {
  // One Google Cloud OAuth client can cover calendar + gmail + drive + maps.
  const clientId =
    process.env[`${service.toUpperCase()}_CLIENT_ID`] ??
    process.env.GOOGLE_CLIENT_ID ??
    process.env.OAUTH_CLIENT_ID
  const clientSecret =
    process.env[`${service.toUpperCase()}_CLIENT_SECRET`] ??
    process.env.GOOGLE_CLIENT_SECRET ??
    process.env.OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

function envCredentials(): CredentialResolver {
  return (service: Service) => {
    const isGoogle = service.startsWith('google_') || service === 'gmail'
    const pair = isGoogle
      ? googleCred(service)
      : (() => {
          const prefix = service.toUpperCase()
          const clientId = process.env[`${prefix}_CLIENT_ID`] ?? process.env.OAUTH_CLIENT_ID
          const clientSecret =
            process.env[`${prefix}_CLIENT_SECRET`] ?? process.env.OAUTH_CLIENT_SECRET
          if (!clientId || !clientSecret) return null
          return { clientId, clientSecret }
        })()
    if (!pair) return null

    const redirectUri =
      process.env[`${service.toUpperCase()}_REDIRECT_URI`] ??
      (process.env.OAUTH_REDIRECT_URI_BASE
        ? `${process.env.OAUTH_REDIRECT_URI_BASE.replace(/\/$/, '')}/${service}`
        : process.env.OAUTH_REDIRECT_URI
          ? process.env.OAUTH_REDIRECT_URI.includes('/oauth/callback/')
            ? process.env.OAUTH_REDIRECT_URI
            : `${process.env.OAUTH_REDIRECT_URI.replace(/\/$/, '')}/${service}`
          : `http://localhost:8787/oauth/callback/${service}`)

    return { ...pair, redirectUri }
  }
}

export async function createConnectorRuntime(opts?: {
  store?: ConnectorStore
  masterKey?: Buffer
  credentials?: CredentialResolver
}) {
  if (!process.env.TOKEN_ENCRYPTION_KEY && !opts?.masterKey) {
    process.env.TOKEN_ENCRYPTION_KEY = generateMasterKey()
    console.warn('[connectors] Generated ephemeral TOKEN_ENCRYPTION_KEY for this process')
  }
  const masterKey = opts?.masterKey ?? loadMasterKey()

  let store = opts?.store
  if (!store) {
    if (process.env.DATABASE_URL) {
      store = createPostgresStore(process.env.DATABASE_URL)
      console.log('[connectors] using PostgresStore')
    } else {
      store = new MemoryStore()
      console.warn('[connectors] DATABASE_URL unset; using MemoryStore')
    }
  }

  const service = new ConnectorService({
    store,
    masterKey,
    credentials: opts?.credentials ?? envCredentials(),
    appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
  })
  const gateway = ComposioGateway.fromEnv()
  if (gateway) {
    console.log('[connectors] Composio gateway enabled (catalog + connect links)')
  } else {
    console.warn('[connectors] COMPOSIO_API_KEY unset; /gateway/* disabled (hand-rolled OAuth only)')
  }
  const app = createApp(service, {
    gateway,
    corsOrigin: process.env.CORS_ORIGIN?.split(',') ?? [
      process.env.APP_BASE_URL ?? 'http://localhost:5173',
      'http://localhost:5173',
    ],
  })
  return { store, service, app, masterKey, gateway }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787)
  const { app, service, store } = await createConnectorRuntime()

  if (store instanceof PostgresStore) {
    try {
      const ok = await store.healthCheck()
      console.log('[connectors] db health', ok)
    } catch (err) {
      console.error('[connectors] db unreachable', err instanceof Error ? err.message : err)
    }
  }

  const REFRESH_MS = 15 * 60 * 1000
  setInterval(() => {
    void service.refreshExpiring().then((r) => {
      console.log('[connectors] refresh sweep', r)
    })
    void service.purgeExpiredStates()
  }, REFRESH_MS)

  console.log(`[connectors] listening on :${port}`)
  Bun.serve({ port, fetch: app.fetch })
}
