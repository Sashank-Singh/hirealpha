import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  fetchCalendarItems,
  googleTokenWithStatus,
  readGmailExact,
} from './connectors/hub'
import {
  todayCalendarMeets,
  EMPTY_TODAY_RESULT,
  digestPayload,
  miniPayload,
} from './hire-api'
import type { SQL } from './hire-api'

describe('Connector failure semantics', () => {
  const originalFetch = globalThis.fetch
  const originalComposioKey = process.env.COMPOSIO_API_KEY

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
    process.env.COMPOSIO_API_KEY = ''
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.COMPOSIO_API_KEY = originalComposioKey
  })

  it('googleTokenWithStatus reports not_connected when no row exists', async () => {
    const mockSql = (async () => []) as unknown as SQL
    const res = await googleTokenWithStatus(mockSql, 'user-no-row', 'calendar')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('not_connected')
    }
  })

  it('googleTokenWithStatus reports auth_expired when refresh token is missing and token is expired', async () => {
    const mockSql = (async () => [
      {
        access_token: 'old-access-tok',
        refresh_token: null,
        expires_at: new Date(Date.now() - 3600_000).toISOString(),
        scopes: 'https://www.googleapis.com/auth/calendar',
      },
    ]) as unknown as SQL
    const res = await googleTokenWithStatus(mockSql, 'user-no-refresh', 'calendar')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('auth_expired')
    }
  })

  it('googleTokenWithStatus reports auth_expired when Google returns 400 invalid_grant', async () => {
    const mockSql = (async () => [
      {
        access_token: 'old-tok',
        refresh_token: 'revoked-refresh-tok',
        expires_at: new Date(Date.now() - 3600_000).toISOString(),
        scopes: 'https://www.googleapis.com/auth/calendar',
      },
    ]) as unknown as SQL

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not found', { status: 404 })
    }

    const res = await googleTokenWithStatus(mockSql, 'user-revoked', 'calendar')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('auth_expired')
    }
  })

  it('googleTokenWithStatus reports timeout on abort/timeout', async () => {
    const mockSql = (async () => [
      {
        access_token: 'old-tok',
        refresh_token: 'some-refresh-tok',
        expires_at: new Date(Date.now() - 3600_000).toISOString(),
        scopes: 'https://www.googleapis.com/auth/calendar',
      },
    ]) as unknown as SQL

    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }

    const res = await googleTokenWithStatus(mockSql, 'user-timeout', 'calendar')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('timeout')
    }
  })

  it('googleTokenWithStatus reports provider_error on HTTP 500', async () => {
    const mockSql = (async () => [
      {
        access_token: 'old-tok',
        refresh_token: 'some-refresh-tok',
        expires_at: new Date(Date.now() - 3600_000).toISOString(),
        scopes: 'https://www.googleapis.com/auth/calendar',
      },
    ]) as unknown as SQL

    globalThis.fetch = async () => {
      return new Response('Internal Server Error', { status: 500 })
    }

    const res = await googleTokenWithStatus(mockSql, 'user-500', 'calendar')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('provider_error')
    }
  })

  it('fetchCalendarItems distinguishes 401 auth_expired from empty list', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('googleapis.com/calendar/v3/calendars/primary/events')) {
        return new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not found', { status: 404 })
    }

    const res = await fetchCalendarItems('expired-access-token', {
      timeMin: new Date(),
      timeMax: new Date(Date.now() + 86400_000),
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('auth_expired')
      expect(res.status).toBe(401)
    }
  })

  it('readGmailExact returns status auth_expired when token lookup fails with auth_expired', async () => {
    const mockSql = (async () => [
      {
        access_token: 'expired-tok',
        refresh_token: null,
        expires_at: new Date(Date.now() - 3600_000).toISOString(),
        scopes: 'https://www.googleapis.com/auth/gmail.readonly',
      },
    ]) as unknown as SQL

    const res = await readGmailExact(mockSql, 'user-expired', 'newer_than:2d', 10)
    expect(res.items).toEqual([])
    expect(res.failed).toBe(true)
    expect(res.status).toBe('auth_expired')
  })

  it('todayCalendarMeets flags calendarStatus as auth_expired and does not report empty day as successful', async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const q = strings.join('')
      if (q.includes('FROM hire_google_tokens')) {
        return [
          {
            access_token: 'old-access-tok',
            refresh_token: null,
            expires_at: new Date(Date.now() - 3600_000).toISOString(),
            scopes: 'https://www.googleapis.com/auth/calendar',
          },
        ]
      }
      return []
    }) as unknown as SQL

    const user = {
      id: 'test-user-id',
      email: 'test@example.com',
      connected_connectors: ['calendar'],
      timezone: 'America/Los_Angeles',
    }

    const res = await todayCalendarMeets(mockSql, user, 'cofounder')
    expect(res.meets).toEqual([])
    expect(res.calendarConnected).toBe(true)
    expect(res.calendarStatus).toBe('auth_expired')
  })

  it('EMPTY_TODAY_RESULT reports calendarStatus as not_connected', () => {
    expect(EMPTY_TODAY_RESULT.calendarStatus).toBe('not_connected')
    expect(EMPTY_TODAY_RESULT.meets).toEqual([])
  })

  it('digestPayload distinguishes calendar auth_expired and surfaces in lead', async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const q = strings.join('')
      if (q.includes('FROM hire_google_tokens')) {
        return [
          {
            access_token: 'old-access-tok',
            refresh_token: null,
            expires_at: new Date(Date.now() - 3600_000).toISOString(),
            scopes: 'https://www.googleapis.com/auth/calendar',
          },
        ]
      }
      if (q.includes('hire_brief_cache')) return []
      if (q.includes('hire_habits')) return []
      if (q.includes('hire_reminders')) return []
      if (q.includes('hire_open_loops')) return []
      return []
    }) as unknown as SQL

    const user = {
      id: 'test-user-digest',
      timezone: 'America/Los_Angeles',
      name: 'Tester',
    }

    const digest = await digestPayload(mockSql, user, 'friend')
    expect(digest.story.calendarStatus).toBe('auth_expired')
    expect(digest.story.lead).toBe('Calendar authorization expired. Reconnect in Settings.')
  })

  it('miniPayload pick_night reflects expired calendar and gmail credentials', async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const q = strings.join('')
      if (q.includes('FROM hire_google_tokens')) {
        return [
          {
            access_token: 'old-access-tok',
            refresh_token: null,
            expires_at: new Date(Date.now() - 3600_000).toISOString(),
            scopes: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.readonly',
          },
        ]
      }
      return []
    }) as unknown as SQL

    const user = {
      id: 'test-user-mini',
      timezone: 'America/Los_Angeles',
      name: 'Tester',
    }

    const evening = await miniPayload(mockSql, user, 'friend', 'pick_night')
    expect(evening.calendarStatus).toBe('auth_expired')
    expect(evening.mailStatus).toBe('auth_expired')
    const mailSec = evening.sections.find((s) => s.heading === 'Mail since this morning')
    expect(mailSec?.items).toContain('Gmail authorization expired. Reconnect in Settings.')
    const tomSec = evening.sections.find((s) => s.heading === 'Tomorrow')
    expect(tomSec?.items).toContain('Calendar authorization expired. Reconnect in Settings.')
  })
})
