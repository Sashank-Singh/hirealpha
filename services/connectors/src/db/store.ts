import type {
  ConnectedAccount,
  OAuthStateRow,
  Persona,
  PersonaPermission,
  Service,
  ToolCallLogRow,
  User,
} from '../types'

export interface ConnectorStore {
  createUser(input: { phoneNumber: string; email?: string | null }): Promise<User>
  getUser(id: string): Promise<User | null>
  getUserByEmail?(email: string): Promise<User | null>

  /** Optional: upsert account + seed permissions atomically. */
  completeOAuthConnect?(input: {
    account: Omit<ConnectedAccount, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
    permissions: Array<{ persona: Persona; enabled: boolean }>
  }): Promise<ConnectedAccount>

  healthCheck?(): Promise<boolean>

  putOAuthState(row: OAuthStateRow): Promise<void>
  takeOAuthState(state: string): Promise<OAuthStateRow | null>
  purgeExpiredOAuthState(olderThan: Date): Promise<number>

  upsertConnectedAccount(
    account: Omit<ConnectedAccount, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<ConnectedAccount>
  getConnectedAccount(id: string): Promise<ConnectedAccount | null>
  getConnectedAccountByUserService(userId: string, service: Service): Promise<ConnectedAccount | null>
  listConnectedAccounts(userId: string): Promise<ConnectedAccount[]>
  updateConnectedAccount(
    id: string,
    patch: Partial<
      Pick<
        ConnectedAccount,
        | 'accessTokenEnc'
        | 'refreshTokenEnc'
        | 'tokenExpiresAt'
        | 'scopesGranted'
        | 'status'
        | 'lastRefreshedAt'
        | 'externalAccountId'
      >
    >,
  ): Promise<ConnectedAccount>

  replacePermissionsForAccount(
    userId: string,
    connectedAccountId: string,
    rows: Array<{ persona: Persona; enabled: boolean }>,
  ): Promise<PersonaPermission[]>
  listPermissions(userId: string): Promise<PersonaPermission[]>
  setPermission(input: {
    userId: string
    persona: Persona
    connectedAccountId: string
    enabled: boolean
  }): Promise<PersonaPermission>
  disablePermissionsForAccount(connectedAccountId: string): Promise<void>

  listExpiringAccounts(within: Date): Promise<ConnectedAccount[]>

  insertToolCall(row: Omit<ToolCallLogRow, 'id' | 'createdAt'> & { id?: string }): Promise<ToolCallLogRow>
  listToolCalls(
    userId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: ToolCallLogRow[]; nextCursor: string | null }>
}
