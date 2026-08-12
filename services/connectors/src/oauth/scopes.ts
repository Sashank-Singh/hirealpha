/**
 * Minimum OAuth scopes per service — sourced from provider docs (2026).
 * Do not widen without product + security review.
 *
 * Refs:
 * - Google: https://developers.google.com/identity/protocols/oauth2/scopes
 * - Slack: https://docs.slack.dev/reference/scopes
 * - Notion: capabilities (not classic scopes) — https://developers.notion.com/guides/get-started/authorization
 * - Linear: https://linear.app/developers/oauth-2-0-authentication
 * - GitHub: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
 * - Figma: https://developers.figma.com/docs/rest-api/scopes/
 * - Spotify: https://developer.spotify.com/documentation/web-api/concepts/scopes
 * - Stripe Connect: https://docs.stripe.com/connect/oauth-reference
 * - Uber: https://developer.uber.com/docs/riders/guides/authentication/introduction
 */
import type { Service } from '../types'

export interface ProviderOAuthConfig {
  service: Service
  authorizeUrl: string
  tokenUrl: string
  revokeUrl?: string
  /** Scopes requested at authorize time. Empty for Notion (capability-based). */
  scopes: string[]
  scopeDelimiter: ' ' | ','
  extraAuthParams?: Record<string, string>
  /** How to send client auth on token exchange. */
  tokenAuth: 'body' | 'basic'
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke'

export const PROVIDER_CONFIG: Record<Service, ProviderOAuthConfig> = {
  google_calendar: {
    service: 'google_calendar',
    authorizeUrl: GOOGLE_AUTH,
    tokenUrl: GOOGLE_TOKEN,
    revokeUrl: GOOGLE_REVOKE,
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'openid',
      'email',
    ],
    scopeDelimiter: ' ',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    tokenAuth: 'body',
  },
  gmail: {
    service: 'gmail',
    authorizeUrl: GOOGLE_AUTH,
    tokenUrl: GOOGLE_TOKEN,
    revokeUrl: GOOGLE_REVOKE,
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'openid',
      'email',
    ],
    scopeDelimiter: ' ',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    tokenAuth: 'body',
  },
  google_drive: {
    service: 'google_drive',
    authorizeUrl: GOOGLE_AUTH,
    tokenUrl: GOOGLE_TOKEN,
    revokeUrl: GOOGLE_REVOKE,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'openid',
      'email',
    ],
    scopeDelimiter: ' ',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    tokenAuth: 'body',
  },
  google_maps: {
    service: 'google_maps',
    authorizeUrl: GOOGLE_AUTH,
    tokenUrl: GOOGLE_TOKEN,
    revokeUrl: GOOGLE_REVOKE,
    // Maps Platform typically uses API keys; OAuth user scopes are limited.
    // We request openid/email for identity; maps calls use server API key separately.
    scopes: ['openid', 'email'],
    scopeDelimiter: ' ',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    tokenAuth: 'body',
  },
  slack: {
    service: 'slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revokeUrl: 'https://slack.com/api/auth.revoke',
    scopes: ['channels:read', 'chat:write', 'users:read'],
    scopeDelimiter: ',',
    tokenAuth: 'body',
  },
  notion: {
    service: 'notion',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    // Notion: capabilities configured on the integration; no classic scope param.
    scopes: [],
    scopeDelimiter: ' ',
    extraAuthParams: { owner: 'user' },
    tokenAuth: 'basic',
  },
  linear: {
    service: 'linear',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    revokeUrl: 'https://api.linear.app/oauth/revoke',
    // read + issues:create (narrower than full write)
    scopes: ['read', 'issues:create', 'comments:create'],
    scopeDelimiter: ',',
    tokenAuth: 'body',
  },
  github: {
    service: 'github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user', 'repo:status', 'public_repo'],
    scopeDelimiter: ' ',
    tokenAuth: 'body',
  },
  figma: {
    service: 'figma',
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    revokeUrl: 'https://api.figma.com/v1/oauth/revoke',
    scopes: ['file_content:read', 'file_comments:read', 'current_user:read'],
    scopeDelimiter: ',',
    tokenAuth: 'basic',
  },
  spotify: {
    service: 'spotify',
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    scopes: ['user-read-email', 'user-read-playback-state', 'playlist-read-private'],
    scopeDelimiter: ' ',
    tokenAuth: 'basic',
  },
  stripe: {
    service: 'stripe',
    authorizeUrl: 'https://connect.stripe.com/oauth/authorize',
    tokenUrl: 'https://connect.stripe.com/oauth/token',
    revokeUrl: 'https://connect.stripe.com/oauth/deauthorize',
    // read_only for glance revenue — never request write/charge by default
    scopes: ['read_only'],
    scopeDelimiter: ' ',
    extraAuthParams: { response_type: 'code' },
    tokenAuth: 'body',
  },
  uber: {
    service: 'uber',
    authorizeUrl: 'https://login.uber.com/oauth/v2/authorize',
    tokenUrl: 'https://login.uber.com/oauth/v2/token',
    revokeUrl: 'https://login.uber.com/oauth/v2/revoke',
    scopes: ['profile', 'request'],
    scopeDelimiter: ' ',
    tokenAuth: 'body',
  },
}
