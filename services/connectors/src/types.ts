/** Connector services (OAuth providers). */
export const SERVICES = [
  'google_calendar',
  'gmail',
  'slack',
  'notion',
  'linear',
  'github',
  'google_drive',
  'spotify',
  'uber',
  'stripe',
  'figma',
  'google_maps',
] as const

export type Service = (typeof SERVICES)[number]

export const PERSONAS = ['friend', 'coworker', 'cofounder'] as const
export type Persona = (typeof PERSONAS)[number]

export type AccountStatus = 'active' | 'expired' | 'revoked' | 'error'
export type ToolCallStatus = 'success' | 'error' | 'user_denied' | 'pending_confirmation'

export interface User {
  id: string
  phoneNumber: string
  email: string | null
  createdAt: Date
}

export interface ConnectedAccount {
  id: string
  userId: string
  service: Service
  /** Ciphertext only — never expose to API clients. */
  accessTokenEnc: string
  refreshTokenEnc: string | null
  tokenExpiresAt: Date | null
  scopesGranted: string[]
  externalAccountId: string | null
  status: AccountStatus
  lastRefreshedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface PersonaPermission {
  id: string
  userId: string
  persona: Persona
  connectedAccountId: string
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface OAuthStateRow {
  state: string
  userId: string
  service: Service
  persona: Persona | null
  redirectAfter: string | null
  createdAt: Date
}

export interface ToolCallLogRow {
  id: string
  userId: string
  persona: Persona
  connectedAccountId: string | null
  toolName: string
  inputSummary: string | null
  outputSummary: string | null
  status: ToolCallStatus
  createdAt: Date
}

/** Safe DTO for frontend — never includes tokens. */
export interface ConnectionStatusDto {
  id: string
  service: Service
  status: AccountStatus
  scopesGranted: string[]
  externalAccountId: string | null
  lastRefreshedAt: string | null
  createdAt: string
  personas: Array<{ persona: Persona; enabled: boolean }>
}

export interface ActiveToolBinding {
  connectedAccountId: string
  service: Service
  /** Decrypted access token — internal only; never serialize to HTTP clients. */
  accessToken: string
  scopesGranted: string[]
  expiresAt: Date | null
}

export interface TokenPair {
  accessToken: string
  refreshToken?: string | null
  expiresInSeconds?: number | null
  scopesGranted: string[]
  externalAccountId?: string | null
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INVALID_STATE'
      | 'EXPIRED_STATE'
      | 'NOT_FOUND'
      | 'RATE_LIMITED'
      | 'REFRESH_FAILED'
      | 'PERMISSION_DENIED'
      | 'CONFIRMATION_REQUIRED'
      | 'BAD_REQUEST'
      | 'PROVIDER_ERROR',
  ) {
    super(message)
    this.name = 'ConnectorError'
  }
}
