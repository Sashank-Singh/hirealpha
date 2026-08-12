/**
 * Google Calendar tools backed by the real Calendar API.
 * Docs: https://developers.google.com/calendar/api/v3/reference
 */
import type { ConnectorService } from '../oauth/service'
import { ConnectorError, type Persona } from '../types'
import { redactSecrets } from '../crypto/tokens'

const CAL_BASE = 'https://www.googleapis.com/calendar/v3'

export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'EXPIRED_GRANT'
      | 'INSUFFICIENT_SCOPE'
      | 'RATE_LIMITED'
      | 'NOT_FOUND'
      | 'PROVIDER_ERROR',
    public readonly reconnectHint: string,
  ) {
    super(message)
    this.name = 'GoogleApiError'
  }
}

function mapGoogleError(status: number, body: string): GoogleApiError {
  const lower = body.toLowerCase()
  if (status === 401 || lower.includes('invalid_grant') || lower.includes('invalid credentials')) {
    return new GoogleApiError(
      'Google rejected the access token',
      'EXPIRED_GRANT',
      'I lost access to your calendar. Can you reconnect it?',
    )
  }
  if (status === 403 && lower.includes('insufficient')) {
    return new GoogleApiError(
      'Missing Calendar scope',
      'INSUFFICIENT_SCOPE',
      'Calendar access is missing a required permission. Please reconnect Calendar.',
    )
  }
  if (status === 429) {
    return new GoogleApiError(
      'Google Calendar rate limited',
      'RATE_LIMITED',
      'Google Calendar is rate limiting us. Try again in a minute.',
    )
  }
  if (status === 404) {
    return new GoogleApiError('Event not found', 'NOT_FOUND', 'That calendar event was not found.')
  }
  return new GoogleApiError(
    `Google Calendar error (${status})`,
    'PROVIDER_ERROR',
    'Something went wrong with Google Calendar. Try again, or reconnect if it keeps failing.',
  )
}

async function calFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${CAL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw mapGoogleError(res.status, text)
  if (!text) return null
  return JSON.parse(text) as unknown
}

export interface CalendarToolContext {
  connectors: ConnectorService
  userId: string
  persona: Persona
  connectedAccountId: string
}

export async function listEvents(
  ctx: CalendarToolContext,
  input: { timeMin: string; timeMax: string; maxResults?: number },
) {
  const token = await ctx.connectors.resolveAccessToken(ctx.connectedAccountId)
  try {
    const params = new URLSearchParams({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(input.maxResults ?? 25),
    })
    const data = (await calFetch(
      token,
      `/calendars/primary/events?${params}`,
    )) as { items?: unknown[] }
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.list_events',
      inputSummary: redactSecrets(`${input.timeMin}..${input.timeMax}`),
      outputSummary: `${data.items?.length ?? 0} events`,
      status: 'success',
    })
    return data.items ?? []
  } catch (err) {
    const msg = err instanceof GoogleApiError ? err.reconnectHint : 'Calendar list failed'
    if (err instanceof GoogleApiError && err.code === 'EXPIRED_GRANT') {
      // mark error via resolve path on next call; surface friendly message
    }
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.list_events',
      inputSummary: redactSecrets(`${input.timeMin}..${input.timeMax}`),
      outputSummary: msg,
      status: 'error',
    })
    throw err instanceof GoogleApiError
      ? new ConnectorError(err.reconnectHint, 'PROVIDER_ERROR')
      : err
  }
}

export async function getEvent(ctx: CalendarToolContext, eventId: string) {
  const token = await ctx.connectors.resolveAccessToken(ctx.connectedAccountId)
  try {
    const data = await calFetch(
      token,
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
    )
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.get_event',
      inputSummary: eventId,
      outputSummary: 'ok',
      status: 'success',
    })
    return data
  } catch (err) {
    const msg = err instanceof GoogleApiError ? err.reconnectHint : 'get_event failed'
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.get_event',
      inputSummary: eventId,
      outputSummary: msg,
      status: 'error',
    })
    throw err instanceof GoogleApiError
      ? new ConnectorError(err.reconnectHint, 'PROVIDER_ERROR')
      : err
  }
}

export async function createEvent(
  ctx: CalendarToolContext,
  input: {
    title: string
    start: string
    end: string
    attendees?: string[]
    location?: string
    confirmed?: boolean
    confirmationKey?: string
  },
) {
  const summary = `Create "${input.title}" ${input.start} to ${input.end}`
  const gate = await ctx.connectors.authorizeToolCall({
    userId: ctx.userId,
    persona: ctx.persona,
    toolName: 'calendar.create_event',
    connectedAccountId: ctx.connectedAccountId,
    inputSummary: summary,
    confirmed: input.confirmed,
    confirmationKey: input.confirmationKey,
  })
  if (!gate.allowed) {
    return { needsConfirmation: true as const, confirmationKey: gate.confirmationKey, summary }
  }

  const token = await ctx.connectors.resolveAccessToken(ctx.connectedAccountId)
  try {
    const body = {
      summary: input.title,
      location: input.location,
      start: { dateTime: input.start },
      end: { dateTime: input.end },
      attendees: input.attendees?.map((email) => ({ email })),
    }
    const data = await calFetch(token, '/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.create_event',
      inputSummary: redactSecrets(summary),
      outputSummary: 'created',
      status: 'success',
    })
    return { needsConfirmation: false as const, event: data }
  } catch (err) {
    const msg = err instanceof GoogleApiError ? err.reconnectHint : 'create failed'
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.create_event',
      inputSummary: redactSecrets(summary),
      outputSummary: msg,
      status: 'error',
    })
    throw err instanceof GoogleApiError
      ? new ConnectorError(err.reconnectHint, 'PROVIDER_ERROR')
      : err
  }
}

export async function updateEvent(
  ctx: CalendarToolContext,
  input: {
    eventId: string
    changes: Record<string, unknown>
    confirmed?: boolean
    confirmationKey?: string
  },
) {
  const summary = `Update event ${input.eventId}`
  const gate = await ctx.connectors.authorizeToolCall({
    userId: ctx.userId,
    persona: ctx.persona,
    toolName: 'calendar.update_event',
    connectedAccountId: ctx.connectedAccountId,
    inputSummary: summary,
    confirmed: input.confirmed,
    confirmationKey: input.confirmationKey,
  })
  if (!gate.allowed) {
    return { needsConfirmation: true as const, confirmationKey: gate.confirmationKey, summary }
  }

  const token = await ctx.connectors.resolveAccessToken(ctx.connectedAccountId)
  try {
    const data = await calFetch(
      token,
      `/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
      { method: 'PATCH', body: JSON.stringify(input.changes) },
    )
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.update_event',
      inputSummary: summary,
      outputSummary: 'updated',
      status: 'success',
    })
    return { needsConfirmation: false as const, event: data }
  } catch (err) {
    const msg = err instanceof GoogleApiError ? err.reconnectHint : 'update failed'
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.update_event',
      inputSummary: summary,
      outputSummary: msg,
      status: 'error',
    })
    throw err instanceof GoogleApiError
      ? new ConnectorError(err.reconnectHint, 'PROVIDER_ERROR')
      : err
  }
}

export async function deleteEvent(
  ctx: CalendarToolContext,
  input: { eventId: string; confirmed?: boolean; confirmationKey?: string },
) {
  const summary = `DELETE calendar event ${input.eventId}`
  const gate = await ctx.connectors.authorizeToolCall({
    userId: ctx.userId,
    persona: ctx.persona,
    toolName: 'calendar.delete_event',
    connectedAccountId: ctx.connectedAccountId,
    inputSummary: summary,
    confirmed: input.confirmed,
    confirmationKey: input.confirmationKey,
  })
  if (!gate.allowed) {
    return { needsConfirmation: true as const, confirmationKey: gate.confirmationKey, summary }
  }

  const token = await ctx.connectors.resolveAccessToken(ctx.connectedAccountId)
  try {
    await calFetch(token, `/calendars/primary/events/${encodeURIComponent(input.eventId)}`, {
      method: 'DELETE',
    })
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.delete_event',
      inputSummary: summary,
      outputSummary: 'deleted',
      status: 'success',
    })
    return { needsConfirmation: false as const, deleted: true }
  } catch (err) {
    const msg = err instanceof GoogleApiError ? err.reconnectHint : 'delete failed'
    await ctx.connectors.logToolResult({
      userId: ctx.userId,
      persona: ctx.persona,
      connectedAccountId: ctx.connectedAccountId,
      toolName: 'calendar.delete_event',
      inputSummary: summary,
      outputSummary: msg,
      status: 'error',
    })
    throw err instanceof GoogleApiError
      ? new ConnectorError(err.reconnectHint, 'PROVIDER_ERROR')
      : err
  }
}
