import { randomBytes } from 'node:crypto'
import type { Service, TokenPair } from '../types'
import { PROVIDER_CONFIG } from './scopes'

export interface OAuthClientCredentials {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export type CredentialResolver = (service: Service) => OAuthClientCredentials | null

/** Pluggable HTTP for tests — never log response bodies that may contain tokens. */
export type FetchFn = typeof fetch

export function createStateToken(): string {
  return randomBytes(24).toString('base64url')
}

export function buildAuthorizeUrl(
  service: Service,
  state: string,
  creds: OAuthClientCredentials,
): string {
  const cfg = PROVIDER_CONFIG[service]
  const url = new URL(cfg.authorizeUrl)
  url.searchParams.set('client_id', creds.clientId)
  url.searchParams.set('redirect_uri', creds.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  if (cfg.scopes.length > 0) {
    const key = service === 'slack' ? 'scope' : 'scope'
    // Slack bot scopes use `scope`; user scopes would be `user_scope`.
    url.searchParams.set(key, cfg.scopes.join(cfg.scopeDelimiter))
  }
  for (const [k, v] of Object.entries(cfg.extraAuthParams ?? {})) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

export async function exchangeCode(
  service: Service,
  code: string,
  creds: OAuthClientCredentials,
  fetchFn: FetchFn = fetch,
): Promise<TokenPair> {
  const cfg = PROVIDER_CONFIG[service]
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: creds.redirectUri,
  })

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  if (cfg.tokenAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`
  } else {
    body.set('client_id', creds.clientId)
    body.set('client_secret', creds.clientSecret)
  }

  const res = await fetchFn(cfg.tokenUrl, { method: 'POST', headers, body })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok || json.error) {
    throw new Error(`token_exchange_failed:${service}`)
  }
  return normalizeTokenResponse(service, json)
}

export async function refreshAccessToken(
  service: Service,
  refreshToken: string,
  creds: OAuthClientCredentials,
  fetchFn: FetchFn = fetch,
): Promise<TokenPair> {
  const cfg = PROVIDER_CONFIG[service]
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (cfg.tokenAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`
  } else {
    body.set('client_id', creds.clientId)
    body.set('client_secret', creds.clientSecret)
  }

  const res = await fetchFn(cfg.tokenUrl, { method: 'POST', headers, body })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok || json.error) {
    throw new Error(`refresh_failed:${service}`)
  }
  const pair = normalizeTokenResponse(service, json)
  if (!pair.refreshToken) pair.refreshToken = refreshToken
  return pair
}

export async function revokeToken(
  service: Service,
  token: string,
  creds: OAuthClientCredentials,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const cfg = PROVIDER_CONFIG[service]
  if (!cfg.revokeUrl) return
  try {
    if (service === 'google_calendar' || service === 'gmail' || service === 'google_drive' || service === 'google_maps') {
      await fetchFn(`${cfg.revokeUrl}?token=${encodeURIComponent(token)}`, { method: 'POST' })
      return
    }
    const body = new URLSearchParams({ token, client_id: creds.clientId, client_secret: creds.clientSecret })
    await fetchFn(cfg.revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch {
    // Best-effort revoke — still mark local row revoked.
  }
}

function normalizeTokenResponse(service: Service, json: Record<string, unknown>): TokenPair {
  // Slack oauth.v2.access nests differently
  if (service === 'slack') {
    const access =
      (json.access_token as string | undefined) ??
      ((json.authed_user as { access_token?: string } | undefined)?.access_token)
    if (!access) throw new Error('token_exchange_failed:slack')
    const scopeStr = String(json.scope ?? '')
    return {
      accessToken: access,
      refreshToken: (json.refresh_token as string | undefined) ?? null,
      expiresInSeconds: (json.expires_in as number | undefined) ?? null,
      scopesGranted: scopeStr ? scopeStr.split(/[,\s]+/).filter(Boolean) : PROVIDER_CONFIG.slack.scopes,
      externalAccountId:
        ((json.team as { id?: string } | undefined)?.id as string | undefined) ??
        ((json.authed_user as { id?: string } | undefined)?.id as string | undefined) ??
        null,
    }
  }

  const access = json.access_token as string | undefined
  if (!access) throw new Error(`token_exchange_failed:${service}`)
  const scopeRaw = json.scope ?? json.scopes
  let scopesGranted: string[] = PROVIDER_CONFIG[service].scopes
  if (typeof scopeRaw === 'string' && scopeRaw.length) {
    scopesGranted = scopeRaw.split(/[,\s]+/).filter(Boolean)
  } else if (Array.isArray(scopeRaw)) {
    scopesGranted = scopeRaw.map(String)
  }

  return {
    accessToken: access,
    refreshToken: (json.refresh_token as string | undefined) ?? null,
    expiresInSeconds: (json.expires_in as number | undefined) ?? null,
    scopesGranted,
    externalAccountId:
      (json.stripe_user_id as string | undefined) ??
      (json.workspace_id as string | undefined) ??
      (json.bot_id as string | undefined) ??
      null,
  }
}
