import { randomUUID } from 'node:crypto'
import type { ConnectorStore } from './store'
import type {
  ConnectedAccount,
  OAuthStateRow,
  Persona,
  PersonaPermission,
  Service,
  ToolCallLogRow,
  User,
} from '../types'

function now() {
  return new Date()
}

/** In-memory store for unit tests and local demo without Postgres. */
export class MemoryStore implements ConnectorStore {
  users = new Map<string, User>()
  accounts = new Map<string, ConnectedAccount>()
  permissions = new Map<string, PersonaPermission>()
  oauthStates = new Map<string, OAuthStateRow>()
  toolCalls: ToolCallLogRow[] = []

  async createUser(input: { phoneNumber: string; email?: string | null }): Promise<User> {
    const existing = [...this.users.values()].find((u) => u.phoneNumber === input.phoneNumber)
    if (existing) return existing
    if (input.email) {
      const byEmail = [...this.users.values()].find(
        (u) => u.email === input.email!.trim().toLowerCase(),
      )
      if (byEmail) return byEmail
    }
    const user: User = {
      id: randomUUID(),
      phoneNumber: input.phoneNumber,
      email: input.email?.trim().toLowerCase() ?? null,
      createdAt: now(),
    }
    this.users.set(user.id, user)
    return user
  }

  async getUser(id: string): Promise<User | null> {
    return this.users.get(id) ?? null
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const needle = email.trim().toLowerCase()
    return [...this.users.values()].find((u) => u.email === needle) ?? null
  }

  async healthCheck(): Promise<boolean> {
    return true
  }

  async completeOAuthConnect(input: {
    account: Omit<ConnectedAccount, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
    permissions: Array<{ persona: Persona; enabled: boolean }>
  }): Promise<ConnectedAccount> {
    const account = await this.upsertConnectedAccount(input.account)
    await this.replacePermissionsForAccount(account.userId, account.id, input.permissions)
    return account
  }

  async putOAuthState(row: OAuthStateRow): Promise<void> {
    this.oauthStates.set(row.state, row)
  }

  async takeOAuthState(state: string): Promise<OAuthStateRow | null> {
    const row = this.oauthStates.get(state) ?? null
    if (row) this.oauthStates.delete(state)
    return row
  }

  async purgeExpiredOAuthState(olderThan: Date): Promise<number> {
    let n = 0
    for (const [k, v] of this.oauthStates) {
      if (v.createdAt < olderThan) {
        this.oauthStates.delete(k)
        n++
      }
    }
    return n
  }

  async upsertConnectedAccount(
    account: Omit<ConnectedAccount, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<ConnectedAccount> {
    const existing = [...this.accounts.values()].find(
      (a) => a.userId === account.userId && a.service === account.service,
    )
    const ts = now()
    if (existing) {
      const updated: ConnectedAccount = {
        ...existing,
        ...account,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: ts,
      }
      this.accounts.set(existing.id, updated)
      return updated
    }
    const created: ConnectedAccount = {
      ...account,
      id: account.id ?? randomUUID(),
      createdAt: ts,
      updatedAt: ts,
    }
    this.accounts.set(created.id, created)
    return created
  }

  async getConnectedAccount(id: string): Promise<ConnectedAccount | null> {
    return this.accounts.get(id) ?? null
  }

  async getConnectedAccountByUserService(
    userId: string,
    service: Service,
  ): Promise<ConnectedAccount | null> {
    return (
      [...this.accounts.values()].find((a) => a.userId === userId && a.service === service) ?? null
    )
  }

  async listConnectedAccounts(userId: string): Promise<ConnectedAccount[]> {
    return [...this.accounts.values()].filter((a) => a.userId === userId)
  }

  async updateConnectedAccount(
    id: string,
    patch: Partial<ConnectedAccount>,
  ): Promise<ConnectedAccount> {
    const cur = this.accounts.get(id)
    if (!cur) throw new Error(`account ${id} not found`)
    const next = { ...cur, ...patch, id: cur.id, updatedAt: now() }
    this.accounts.set(id, next)
    return next
  }

  async replacePermissionsForAccount(
    userId: string,
    connectedAccountId: string,
    rows: Array<{ persona: Persona; enabled: boolean }>,
  ): Promise<PersonaPermission[]> {
    for (const [k, p] of this.permissions) {
      if (p.connectedAccountId === connectedAccountId) this.permissions.delete(k)
    }
    const out: PersonaPermission[] = []
    const ts = now()
    for (const r of rows) {
      const row: PersonaPermission = {
        id: randomUUID(),
        userId,
        persona: r.persona,
        connectedAccountId,
        enabled: r.enabled,
        createdAt: ts,
        updatedAt: ts,
      }
      this.permissions.set(row.id, row)
      out.push(row)
    }
    return out
  }

  async listPermissions(userId: string): Promise<PersonaPermission[]> {
    return [...this.permissions.values()].filter((p) => p.userId === userId)
  }

  async setPermission(input: {
    userId: string
    persona: Persona
    connectedAccountId: string
    enabled: boolean
  }): Promise<PersonaPermission> {
    const existing = [...this.permissions.values()].find(
      (p) =>
        p.userId === input.userId &&
        p.persona === input.persona &&
        p.connectedAccountId === input.connectedAccountId,
    )
    const ts = now()
    if (existing) {
      const next = { ...existing, enabled: input.enabled, updatedAt: ts }
      this.permissions.set(existing.id, next)
      return next
    }
    const row: PersonaPermission = {
      id: randomUUID(),
      userId: input.userId,
      persona: input.persona,
      connectedAccountId: input.connectedAccountId,
      enabled: input.enabled,
      createdAt: ts,
      updatedAt: ts,
    }
    this.permissions.set(row.id, row)
    return row
  }

  async disablePermissionsForAccount(connectedAccountId: string): Promise<void> {
    for (const [k, p] of this.permissions) {
      if (p.connectedAccountId === connectedAccountId) {
        this.permissions.set(k, { ...p, enabled: false, updatedAt: now() })
      }
    }
  }

  async listExpiringAccounts(within: Date): Promise<ConnectedAccount[]> {
    return [...this.accounts.values()].filter(
      (a) =>
        a.status === 'active' &&
        a.tokenExpiresAt != null &&
        a.tokenExpiresAt.getTime() <= within.getTime(),
    )
  }

  async insertToolCall(
    row: Omit<ToolCallLogRow, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ToolCallLogRow> {
    const full: ToolCallLogRow = {
      ...row,
      id: row.id ?? randomUUID(),
      createdAt: now(),
    }
    this.toolCalls.push(full)
    return full
  }

  async listToolCalls(
    userId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: ToolCallLogRow[]; nextCursor: string | null }> {
    let items = this.toolCalls
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    if (opts.cursor) {
      const idx = items.findIndex((t) => t.id === opts.cursor)
      items = idx >= 0 ? items.slice(idx + 1) : items
    }
    const page = items.slice(0, opts.limit)
    const nextCursor = page.length === opts.limit ? page[page.length - 1]!.id : null
    return { items: page, nextCursor }
  }
}
