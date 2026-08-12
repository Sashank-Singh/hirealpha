import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import type { ConnectorStore } from './store'
import type {
  AccountStatus,
  ConnectedAccount,
  OAuthStateRow,
  Persona,
  PersonaPermission,
  Service,
  ToolCallLogRow,
  User,
} from '../types'

type Sql = ReturnType<typeof postgres>

function mapUser(r: Record<string, unknown>): User {
  return {
    id: String(r.id),
    phoneNumber: String(r.phone_number),
    email: r.email == null ? null : String(r.email),
    createdAt: new Date(r.created_at as string | Date),
  }
}

function mapAccount(r: Record<string, unknown>): ConnectedAccount {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    service: r.service as Service,
    accessTokenEnc: String(r.access_token),
    refreshTokenEnc: r.refresh_token == null ? null : String(r.refresh_token),
    tokenExpiresAt: r.token_expires_at == null ? null : new Date(r.token_expires_at as string | Date),
    scopesGranted: Array.isArray(r.scopes_granted) ? (r.scopes_granted as string[]) : [],
    externalAccountId: r.external_account_id == null ? null : String(r.external_account_id),
    status: r.status as AccountStatus,
    lastRefreshedAt:
      r.last_refreshed_at == null ? null : new Date(r.last_refreshed_at as string | Date),
    createdAt: new Date(r.created_at as string | Date),
    updatedAt: new Date(r.updated_at as string | Date),
  }
}

function mapPerm(r: Record<string, unknown>): PersonaPermission {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    persona: r.persona as Persona,
    connectedAccountId: String(r.connected_account_id),
    enabled: Boolean(r.enabled),
    createdAt: new Date(r.created_at as string | Date),
    updatedAt: new Date(r.updated_at as string | Date),
  }
}

function mapTool(r: Record<string, unknown>): ToolCallLogRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    persona: r.persona as Persona,
    connectedAccountId: r.connected_account_id == null ? null : String(r.connected_account_id),
    toolName: String(r.tool_name),
    inputSummary: r.input_summary == null ? null : String(r.input_summary),
    outputSummary: r.output_summary == null ? null : String(r.output_summary),
    status: r.status as ToolCallLogRow['status'],
    createdAt: new Date(r.created_at as string | Date),
  }
}

export class PostgresStore implements ConnectorStore {
  readonly sql: Sql

  constructor(databaseUrl: string, opts?: { max?: number }) {
    this.sql = postgres(databaseUrl, {
      max: opts?.max ?? 10,
      idle_timeout: 20,
      connect_timeout: 10,
    })
  }

  async healthCheck(): Promise<boolean> {
    const rows = await this.sql`select 1 as ok`
    return rows[0]?.ok === 1
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }

  async createUser(input: { phoneNumber: string; email?: string | null }): Promise<User> {
    const existing = await this.sql`
      select * from users where phone_number = ${input.phoneNumber} limit 1
    `
    if (existing[0]) return mapUser(existing[0] as Record<string, unknown>)

    if (input.email) {
      const byEmail = await this.sql`
        select * from users where email = ${input.email.trim().toLowerCase()} limit 1
      `
      if (byEmail[0]) return mapUser(byEmail[0] as Record<string, unknown>)
    }

    const rows = await this.sql`
      insert into users (phone_number, email)
      values (${input.phoneNumber}, ${input.email?.trim().toLowerCase() ?? null})
      returning *
    `
    return mapUser(rows[0] as Record<string, unknown>)
  }

  async getUser(id: string): Promise<User | null> {
    const rows = await this.sql`select * from users where id = ${id}::uuid limit 1`
    return rows[0] ? mapUser(rows[0] as Record<string, unknown>) : null
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const rows = await this.sql`
      select * from users where email = ${email.trim().toLowerCase()} limit 1
    `
    return rows[0] ? mapUser(rows[0] as Record<string, unknown>) : null
  }

  async putOAuthState(row: OAuthStateRow): Promise<void> {
    await this.sql`
      insert into oauth_state (state, user_id, service, persona, redirect_after, created_at)
      values (
        ${row.state},
        ${row.userId}::uuid,
        ${row.service}::connector_service,
        ${row.persona}::persona,
        ${row.redirectAfter},
        ${row.createdAt}
      )
      on conflict (state) do update set
        user_id = excluded.user_id,
        service = excluded.service,
        persona = excluded.persona,
        redirect_after = excluded.redirect_after,
        created_at = excluded.created_at
    `
  }

  async takeOAuthState(state: string): Promise<OAuthStateRow | null> {
    const rows = await this.sql`
      delete from oauth_state where state = ${state} returning *
    `
    if (!rows[0]) return null
    const r = rows[0] as Record<string, unknown>
    return {
      state: String(r.state),
      userId: String(r.user_id),
      service: r.service as Service,
      persona: (r.persona as Persona | null) ?? null,
      redirectAfter: r.redirect_after == null ? null : String(r.redirect_after),
      createdAt: new Date(r.created_at as string | Date),
    }
  }

  async purgeExpiredOAuthState(olderThan: Date): Promise<number> {
    const rows = await this.sql`
      delete from oauth_state where created_at < ${olderThan} returning state
    `
    return rows.length
  }

  async upsertConnectedAccount(
    account: Omit<ConnectedAccount, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<ConnectedAccount> {
    const rows = await this.sql`
      insert into connected_accounts (
        id, user_id, service, access_token, refresh_token, token_expires_at,
        scopes_granted, external_account_id, status, last_refreshed_at
      ) values (
        ${account.id ?? randomUUID()}::uuid,
        ${account.userId}::uuid,
        ${account.service}::connector_service,
        ${account.accessTokenEnc},
        ${account.refreshTokenEnc},
        ${account.tokenExpiresAt},
        ${account.scopesGranted},
        ${account.externalAccountId},
        ${account.status}::connected_account_status,
        ${account.lastRefreshedAt}
      )
      on conflict (user_id, service) do update set
        access_token = excluded.access_token,
        refresh_token = coalesce(excluded.refresh_token, connected_accounts.refresh_token),
        token_expires_at = excluded.token_expires_at,
        scopes_granted = excluded.scopes_granted,
        external_account_id = coalesce(excluded.external_account_id, connected_accounts.external_account_id),
        status = excluded.status,
        last_refreshed_at = excluded.last_refreshed_at,
        updated_at = now()
      returning *
    `
    return mapAccount(rows[0] as Record<string, unknown>)
  }

  /**
   * Upsert connection + seed persona permissions in one transaction
   * so users never land "half connected."
   */
  async completeOAuthConnect(input: {
    account: Omit<ConnectedAccount, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
    permissions: Array<{ persona: Persona; enabled: boolean }>
  }): Promise<ConnectedAccount> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        insert into connected_accounts (
          id, user_id, service, access_token, refresh_token, token_expires_at,
          scopes_granted, external_account_id, status, last_refreshed_at
        ) values (
          ${input.account.id ?? randomUUID()}::uuid,
          ${input.account.userId}::uuid,
          ${input.account.service}::connector_service,
          ${input.account.accessTokenEnc},
          ${input.account.refreshTokenEnc},
          ${input.account.tokenExpiresAt},
          ${input.account.scopesGranted},
          ${input.account.externalAccountId},
          ${input.account.status}::connected_account_status,
          ${input.account.lastRefreshedAt}
        )
        on conflict (user_id, service) do update set
          access_token = excluded.access_token,
          refresh_token = coalesce(excluded.refresh_token, connected_accounts.refresh_token),
          token_expires_at = excluded.token_expires_at,
          scopes_granted = excluded.scopes_granted,
          external_account_id = coalesce(excluded.external_account_id, connected_accounts.external_account_id),
          status = excluded.status,
          last_refreshed_at = excluded.last_refreshed_at,
          updated_at = now()
        returning *
      `
      const account = mapAccount(rows[0] as Record<string, unknown>)

      await tx`
        delete from persona_connector_permissions
        where connected_account_id = ${account.id}::uuid
      `

      for (const p of input.permissions) {
        await tx`
          insert into persona_connector_permissions (
            user_id, persona, connected_account_id, enabled
          ) values (
            ${account.userId}::uuid,
            ${p.persona}::persona,
            ${account.id}::uuid,
            ${p.enabled}
          )
        `
      }

      return account
    }) as Promise<ConnectedAccount>
  }

  async getConnectedAccount(id: string): Promise<ConnectedAccount | null> {
    const rows = await this.sql`select * from connected_accounts where id = ${id}::uuid limit 1`
    return rows[0] ? mapAccount(rows[0] as Record<string, unknown>) : null
  }

  async getConnectedAccountByUserService(
    userId: string,
    service: Service,
  ): Promise<ConnectedAccount | null> {
    const rows = await this.sql`
      select * from connected_accounts
      where user_id = ${userId}::uuid and service = ${service}::connector_service
      limit 1
    `
    return rows[0] ? mapAccount(rows[0] as Record<string, unknown>) : null
  }

  async listConnectedAccounts(userId: string): Promise<ConnectedAccount[]> {
    const rows = await this.sql`
      select * from connected_accounts where user_id = ${userId}::uuid order by created_at
    `
    return rows.map((r) => mapAccount(r as Record<string, unknown>))
  }

  async updateConnectedAccount(
    id: string,
    patch: Partial<ConnectedAccount>,
  ): Promise<ConnectedAccount> {
    const cur = await this.getConnectedAccount(id)
    if (!cur) throw new Error(`account ${id} not found`)
    const next = { ...cur, ...patch, id: cur.id }
    const rows = await this.sql`
      update connected_accounts set
        access_token = ${next.accessTokenEnc},
        refresh_token = ${next.refreshTokenEnc},
        token_expires_at = ${next.tokenExpiresAt},
        scopes_granted = ${next.scopesGranted},
        status = ${next.status}::connected_account_status,
        last_refreshed_at = ${next.lastRefreshedAt},
        external_account_id = ${next.externalAccountId},
        updated_at = now()
      where id = ${id}::uuid
      returning *
    `
    return mapAccount(rows[0] as Record<string, unknown>)
  }

  async replacePermissionsForAccount(
    userId: string,
    connectedAccountId: string,
    rows: Array<{ persona: Persona; enabled: boolean }>,
  ): Promise<PersonaPermission[]> {
    return this.sql.begin(async (tx) => {
      await tx`
        delete from persona_connector_permissions
        where connected_account_id = ${connectedAccountId}::uuid
      `
      const out: PersonaPermission[] = []
      for (const r of rows) {
        const inserted = await tx`
          insert into persona_connector_permissions (
            user_id, persona, connected_account_id, enabled
          ) values (
            ${userId}::uuid,
            ${r.persona}::persona,
            ${connectedAccountId}::uuid,
            ${r.enabled}
          )
          returning *
        `
        out.push(mapPerm(inserted[0] as Record<string, unknown>))
      }
      return out
    }) as Promise<PersonaPermission[]>
  }

  async listPermissions(userId: string): Promise<PersonaPermission[]> {
    const rows = await this.sql`
      select * from persona_connector_permissions where user_id = ${userId}::uuid
    `
    return rows.map((r) => mapPerm(r as Record<string, unknown>))
  }

  async setPermission(input: {
    userId: string
    persona: Persona
    connectedAccountId: string
    enabled: boolean
  }): Promise<PersonaPermission> {
    const rows = await this.sql`
      insert into persona_connector_permissions (
        user_id, persona, connected_account_id, enabled
      ) values (
        ${input.userId}::uuid,
        ${input.persona}::persona,
        ${input.connectedAccountId}::uuid,
        ${input.enabled}
      )
      on conflict (user_id, persona, connected_account_id) do update set
        enabled = excluded.enabled,
        updated_at = now()
      returning *
    `
    return mapPerm(rows[0] as Record<string, unknown>)
  }

  async disablePermissionsForAccount(connectedAccountId: string): Promise<void> {
    await this.sql`
      update persona_connector_permissions
      set enabled = false, updated_at = now()
      where connected_account_id = ${connectedAccountId}::uuid
    `
  }

  async listExpiringAccounts(within: Date): Promise<ConnectedAccount[]> {
    const rows = await this.sql`
      select * from connected_accounts
      where status = 'active'
        and token_expires_at is not null
        and token_expires_at <= ${within}
    `
    return rows.map((r) => mapAccount(r as Record<string, unknown>))
  }

  async insertToolCall(
    row: Omit<ToolCallLogRow, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ToolCallLogRow> {
    const rows = await this.sql`
      insert into tool_call_log (
        id, user_id, persona, connected_account_id, tool_name,
        input_summary, output_summary, status
      ) values (
        ${row.id ?? randomUUID()}::uuid,
        ${row.userId}::uuid,
        ${row.persona}::persona,
        ${row.connectedAccountId}::uuid,
        ${row.toolName},
        ${row.inputSummary},
        ${row.outputSummary},
        ${row.status}::tool_call_status
      )
      returning *
    `
    return mapTool(rows[0] as Record<string, unknown>)
  }

  async listToolCalls(
    userId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: ToolCallLogRow[]; nextCursor: string | null }> {
    let rows
    if (opts.cursor) {
      const cursorRows = await this.sql`
        select created_at from tool_call_log where id = ${opts.cursor}::uuid limit 1
      `
      const cursorAt = cursorRows[0]?.created_at
      rows = cursorAt
        ? await this.sql`
            select * from tool_call_log
            where user_id = ${userId}::uuid
              and (created_at, id) < (${cursorAt}, ${opts.cursor}::uuid)
            order by created_at desc, id desc
            limit ${opts.limit}
          `
        : await this.sql`
            select * from tool_call_log
            where user_id = ${userId}::uuid
            order by created_at desc, id desc
            limit ${opts.limit}
          `
    } else {
      rows = await this.sql`
        select * from tool_call_log
        where user_id = ${userId}::uuid
        order by created_at desc, id desc
        limit ${opts.limit}
      `
    }
    const items = rows.map((r) => mapTool(r as Record<string, unknown>))
    const nextCursor = items.length === opts.limit ? items[items.length - 1]!.id : null
    return { items, nextCursor }
  }
}

export function createPostgresStore(databaseUrl: string): PostgresStore {
  return new PostgresStore(databaseUrl)
}
