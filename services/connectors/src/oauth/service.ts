import type { ConnectorStore } from '../db/store'
import { decryptToken, encryptToken, redactSecrets } from '../crypto/tokens'
import {
  defaultEnabledFor,
  isHardDenied,
  isWriteTool,
} from '../permissions'
import {
  buildAuthorizeUrl,
  createStateToken,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  type CredentialResolver,
  type FetchFn,
} from './client'
import { PERSONAS, type Persona, type Service, type ConnectionStatusDto, type ActiveToolBinding, ConnectorError } from '../types'
import { KeyedMutex } from '../util/mutex'

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const REFRESH_SKEW_MS = 10 * 60 * 1000

export interface ConnectorServiceOptions {
  store: ConnectorStore
  masterKey: Buffer
  credentials: CredentialResolver
  fetchFn?: FetchFn
  appBaseUrl?: string
  now?: () => Date
}

export class ConnectorService {
  private store: ConnectorStore
  private masterKey: Buffer
  private credentials: CredentialResolver
  private fetchFn: FetchFn
  private appBaseUrl: string
  private now: () => Date
  /** In-process single-flight for JIT refresh. TODO(multi-instance): Redis lock. */
  private refreshLocks = new KeyedMutex()
  /** Pending write confirmations: key = `${userId}:${persona}:${toolName}:${nonce}` */
  private pendingWrites = new Map<
    string,
    { connectedAccountId: string; inputSummary: string; createdAt: number }
  >()

  constructor(opts: ConnectorServiceOptions) {
    this.store = opts.store
    this.masterKey = opts.masterKey
    this.credentials = opts.credentials
    this.fetchFn = opts.fetchFn ?? fetch
    this.appBaseUrl = opts.appBaseUrl ?? 'http://localhost:8787'
    this.now = opts.now ?? (() => new Date())
  }

  /** Ensure a user row exists for the signed-in platform email. */
  async ensureUser(input: { email: string; phoneNumber?: string }): Promise<{ id: string; email: string }> {
    const email = input.email.trim().toLowerCase()
    if (!email.includes('@')) throw new ConnectorError('Valid email required', 'BAD_REQUEST')
    const existing = this.store.getUserByEmail
      ? await this.store.getUserByEmail(email)
      : null
    if (existing) return { id: existing.id, email: existing.email ?? email }
    const phone = input.phoneNumber?.trim() || `mailto:${email}`
    const user = await this.store.createUser({ phoneNumber: phone, email })
    return { id: user.id, email: user.email ?? email }
  }

  async health(): Promise<{ ok: boolean; db: boolean }> {
    const db = this.store.healthCheck ? await this.store.healthCheck() : true
    return { ok: db, db }
  }

  async startConnect(input: {
    userId: string
    service: Service
    persona?: Persona | null
    redirectAfter?: string | null
  }): Promise<{ authorizeUrl: string; state: string }> {
    const user = await this.store.getUser(input.userId)
    if (!user) throw new ConnectorError('User not found', 'NOT_FOUND')
    const creds = this.credentials(input.service)
    if (!creds) throw new ConnectorError(`OAuth not configured for ${input.service}`, 'BAD_REQUEST')

    const state = createStateToken()
    await this.store.putOAuthState({
      state,
      userId: input.userId,
      service: input.service,
      persona: input.persona ?? null,
      redirectAfter: input.redirectAfter ?? null,
      createdAt: this.now(),
    })
    return { authorizeUrl: buildAuthorizeUrl(input.service, state, creds), state }
  }

  async handleCallback(input: {
    service: Service
    code: string
    state: string
  }): Promise<{ redirectTo: string; connectedAccountId: string }> {
    const row = await this.store.takeOAuthState(input.state)
    if (!row) throw new ConnectorError('Invalid OAuth state', 'INVALID_STATE')
    if (row.service !== input.service) {
      throw new ConnectorError('OAuth state service mismatch', 'INVALID_STATE')
    }
    if (this.now().getTime() - row.createdAt.getTime() > OAUTH_STATE_TTL_MS) {
      throw new ConnectorError('OAuth state expired', 'EXPIRED_STATE')
    }

    const creds = this.credentials(input.service)
    if (!creds) throw new ConnectorError(`OAuth not configured for ${input.service}`, 'BAD_REQUEST')

    const tokens = await exchangeCode(input.service, input.code, creds, this.fetchFn)
    const expiresAt =
      tokens.expiresInSeconds != null
        ? new Date(this.now().getTime() + tokens.expiresInSeconds * 1000)
        : null

    const permissions = PERSONAS.map((persona) => ({
      persona,
      enabled: defaultEnabledFor(persona, input.service),
    }))

    const accountPayload = {
      userId: row.userId,
      service: input.service,
      accessTokenEnc: encryptToken(tokens.accessToken, this.masterKey),
      refreshTokenEnc: tokens.refreshToken
        ? encryptToken(tokens.refreshToken, this.masterKey)
        : null,
      tokenExpiresAt: expiresAt,
      scopesGranted: tokens.scopesGranted,
      externalAccountId: tokens.externalAccountId ?? null,
      status: 'active' as const,
      lastRefreshedAt: this.now(),
    }

    const account = this.store.completeOAuthConnect
      ? await this.store.completeOAuthConnect({ account: accountPayload, permissions })
      : await (async () => {
          const a = await this.store.upsertConnectedAccount(accountPayload)
          await this.store.replacePermissionsForAccount(row.userId, a.id, permissions)
          return a
        })()

    const redirectTo =
      row.redirectAfter ??
      `${this.appBaseUrl}/app/hires/${row.persona ?? 'friend'}?connected=${input.service}`
    return { redirectTo, connectedAccountId: account.id }
  }

  private async seedDefaultPermissions(
    userId: string,
    connectedAccountId: string,
    service: Service,
  ): Promise<void> {
    await this.store.replacePermissionsForAccount(
      userId,
      connectedAccountId,
      PERSONAS.map((persona) => ({
        persona,
        enabled: defaultEnabledFor(persona, service),
      })),
    )
  }

  async disconnect(connectedAccountId: string): Promise<void> {
    const account = await this.store.getConnectedAccount(connectedAccountId)
    if (!account) throw new ConnectorError('Connection not found', 'NOT_FOUND')

    const creds = this.credentials(account.service)
    if (creds) {
      try {
        const access = decryptToken(account.accessTokenEnc, this.masterKey)
        await revokeToken(account.service, access, creds, this.fetchFn)
      } catch {
        // still revoke locally
      }
    }

    await this.store.updateConnectedAccount(connectedAccountId, { status: 'revoked' })
    await this.store.disablePermissionsForAccount(connectedAccountId)
  }

  async listConnections(userId: string): Promise<ConnectionStatusDto[]> {
    const [accounts, perms] = await Promise.all([
      this.store.listConnectedAccounts(userId),
      this.store.listPermissions(userId),
    ])
    return accounts
      .filter((a) => a.status !== 'revoked')
      .map((a) => ({
        id: a.id,
        service: a.service,
        status: a.status,
        scopesGranted: a.scopesGranted,
        externalAccountId: a.externalAccountId,
        lastRefreshedAt: a.lastRefreshedAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
        personas: PERSONAS.map((persona) => {
          const p = perms.find((x) => x.connectedAccountId === a.id && x.persona === persona)
          return { persona, enabled: p?.enabled ?? false }
        }),
      }))
  }

  async patchPermissions(
    userId: string,
    persona: Persona,
    updates: Array<{ connectedAccountId: string; enabled: boolean }>,
  ): Promise<ConnectionStatusDto[]> {
    for (const u of updates) {
      const account = await this.store.getConnectedAccount(u.connectedAccountId)
      if (!account || account.userId !== userId) {
        throw new ConnectorError('Connection not found', 'NOT_FOUND')
      }
      if (u.enabled && isHardDenied(persona, account.service)) {
        throw new ConnectorError(
          'Stripe cannot be enabled for Friend',
          'PERMISSION_DENIED',
        )
      }
      await this.store.setPermission({
        userId,
        persona,
        connectedAccountId: u.connectedAccountId,
        enabled: u.enabled,
      })
    }
    return this.listConnections(userId)
  }

  /**
   * Internal: chat layer calls this before each model request.
   * Returns decrypted tokens only in-process — never return this over HTTP to browsers.
   */
  async getActiveToolsForPersona(
    userId: string,
    persona: Persona,
  ): Promise<ActiveToolBinding[]> {
    const [accounts, perms] = await Promise.all([
      this.store.listConnectedAccounts(userId),
      this.store.listPermissions(userId),
    ])

    const enabledIds = new Set(
      perms
        .filter((p) => p.persona === persona && p.enabled)
        .map((p) => p.connectedAccountId),
    )

    const out: ActiveToolBinding[] = []
    for (const account of accounts) {
      if (account.status !== 'active') continue
      if (!enabledIds.has(account.id)) continue
      if (isHardDenied(persona, account.service)) continue

      let working = account
      if (this.needsRefresh(account)) {
        try {
          working = await this.refreshAccount(account)
        } catch {
          await this.store.updateConnectedAccount(account.id, { status: 'error' })
          continue
        }
      }

      out.push({
        connectedAccountId: working.id,
        service: working.service,
        accessToken: decryptToken(working.accessTokenEnc, this.masterKey),
        scopesGranted: working.scopesGranted,
        expiresAt: working.tokenExpiresAt,
      })
    }
    return out
  }

  /** Resolve a fresh access token for a connected account (JIT refresh, single-flight). */
  async resolveAccessToken(connectedAccountId: string): Promise<string> {
    const account = await this.store.getConnectedAccount(connectedAccountId)
    if (!account || account.status !== 'active') {
      throw new ConnectorError(
        'I lost access to this account. Can you reconnect it?',
        'REFRESH_FAILED',
      )
    }
    let working = account
    if (this.needsRefresh(account)) {
      working = await this.refreshAccount(account)
    }
    return decryptToken(working.accessTokenEnc, this.masterKey)
  }

  private needsRefresh(account: { tokenExpiresAt: Date | null; refreshTokenEnc: string | null }): boolean {
    if (!account.tokenExpiresAt || !account.refreshTokenEnc) return false
    return account.tokenExpiresAt.getTime() - this.now().getTime() <= REFRESH_SKEW_MS
  }

  async refreshAccount(account: {
    id: string
    service: Service
    refreshTokenEnc: string | null
  }): Promise<import('../types').ConnectedAccount> {
    // Single-flight per connected_account_id so parallel tool calls don't double-hit Google.
    return this.refreshLocks.runExclusive(account.id, async () => {
      const fresh = await this.store.getConnectedAccount(account.id)
      if (!fresh) throw new ConnectorError('Connection not found', 'NOT_FOUND')
      if (!this.needsRefresh(fresh)) return fresh

      if (!fresh.refreshTokenEnc) {
        throw new ConnectorError('No refresh token', 'REFRESH_FAILED')
      }
      const creds = this.credentials(fresh.service)
      if (!creds) throw new ConnectorError('Missing OAuth credentials', 'REFRESH_FAILED')

      const refreshPlain = decryptToken(fresh.refreshTokenEnc, this.masterKey)
      try {
        const tokens = await refreshAccessToken(
          fresh.service,
          refreshPlain,
          creds,
          this.fetchFn,
        )
        return this.store.updateConnectedAccount(fresh.id, {
          accessTokenEnc: encryptToken(tokens.accessToken, this.masterKey),
          refreshTokenEnc: tokens.refreshToken
            ? encryptToken(tokens.refreshToken, this.masterKey)
            : fresh.refreshTokenEnc,
          tokenExpiresAt:
            tokens.expiresInSeconds != null
              ? new Date(this.now().getTime() + tokens.expiresInSeconds * 1000)
              : null,
          lastRefreshedAt: this.now(),
          status: 'active',
          scopesGranted: tokens.scopesGranted,
        })
      } catch {
        await this.store.updateConnectedAccount(fresh.id, { status: 'error' })
        throw new ConnectorError(
          'I lost access to this account. Can you reconnect it?',
          'REFRESH_FAILED',
        )
      }
    })
  }

  async refreshExpiring(): Promise<{ refreshed: number; failed: number }> {
    const within = new Date(this.now().getTime() + REFRESH_SKEW_MS)
    const accounts = await this.store.listExpiringAccounts(within)
    let refreshed = 0
    let failed = 0
    for (const a of accounts) {
      try {
        await this.refreshAccount(a)
        refreshed++
      } catch {
        failed++
      }
    }
    return { refreshed, failed }
  }

  async purgeExpiredStates(): Promise<number> {
    return this.store.purgeExpiredOAuthState(
      new Date(this.now().getTime() - OAUTH_STATE_TTL_MS),
    )
  }

  /**
   * Gate write tools: first call proposes + logs pending_confirmation;
   * second call with confirmed=true executes after user says yes.
   */
  async authorizeToolCall(input: {
    userId: string
    persona: Persona
    toolName: string
    connectedAccountId: string
    inputSummary: string
    confirmed?: boolean
    confirmationKey?: string
  }): Promise<{ allowed: true } | { allowed: false; reason: string; confirmationKey?: string }> {
    const account = await this.store.getConnectedAccount(input.connectedAccountId)
    if (!account || account.userId !== input.userId || account.status !== 'active') {
      return { allowed: false, reason: 'connection_unavailable' }
    }
    if (isHardDenied(input.persona, account.service)) {
      return { allowed: false, reason: 'hard_denied' }
    }
    const perms = await this.store.listPermissions(input.userId)
    const ok = perms.some(
      (p) =>
        p.connectedAccountId === input.connectedAccountId &&
        p.persona === input.persona &&
        p.enabled,
    )
    if (!ok) return { allowed: false, reason: 'persona_disabled' }

    const summary = redactSecrets(input.inputSummary)

    if (isWriteTool(input.toolName) && !input.confirmed) {
      const confirmationKey =
        input.confirmationKey ??
        `${input.userId}:${input.persona}:${input.toolName}:${createStateToken()}`
      this.pendingWrites.set(confirmationKey, {
        connectedAccountId: input.connectedAccountId,
        inputSummary: summary,
        createdAt: this.now().getTime(),
      })
      await this.store.insertToolCall({
        userId: input.userId,
        persona: input.persona,
        connectedAccountId: input.connectedAccountId,
        toolName: input.toolName,
        inputSummary: summary,
        outputSummary: 'awaiting_user_confirmation',
        status: 'pending_confirmation',
      })
      return {
        allowed: false,
        reason: 'confirmation_required',
        confirmationKey,
      }
    }

    if (isWriteTool(input.toolName) && input.confirmed) {
      if (!input.confirmationKey || !this.pendingWrites.has(input.confirmationKey)) {
        await this.store.insertToolCall({
          userId: input.userId,
          persona: input.persona,
          connectedAccountId: input.connectedAccountId,
          toolName: input.toolName,
          inputSummary: summary,
          outputSummary: 'missing_confirmation',
          status: 'user_denied',
        })
        return { allowed: false, reason: 'confirmation_required' }
      }
      this.pendingWrites.delete(input.confirmationKey)
    }

    return { allowed: true }
  }

  async logToolResult(input: {
    userId: string
    persona: Persona
    connectedAccountId: string | null
    toolName: string
    inputSummary: string
    outputSummary: string
    status: 'success' | 'error' | 'user_denied'
  }) {
    return this.store.insertToolCall({
      userId: input.userId,
      persona: input.persona,
      connectedAccountId: input.connectedAccountId,
      toolName: input.toolName,
      inputSummary: redactSecrets(input.inputSummary),
      outputSummary: redactSecrets(input.outputSummary),
      status: input.status,
    })
  }

  async listActivity(userId: string, opts: { limit?: number; cursor?: string } = {}) {
    return this.store.listToolCalls(userId, {
      limit: opts.limit ?? 50,
      cursor: opts.cursor,
    })
  }
}
