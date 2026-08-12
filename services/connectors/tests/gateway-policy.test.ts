import { describe, expect, test } from 'bun:test'
import {
  featuredToolkits,
  isToolkitAllowed,
  normalizeToolkitSlug,
  UI_OR_SERVICE_TO_COMPOSIO,
} from '../src/gateway/policy'

describe('gateway policy', () => {
  test('Friend never gets Stripe', () => {
    expect(isToolkitAllowed('friend', 'stripe')).toBe(false)
    expect(isToolkitAllowed('friend', 'googlecalendar')).toBe(true)
  })

  test('normalize collapses separators', () => {
    expect(normalizeToolkitSlug('google_calendar')).toBe('googlecalendar')
    expect(normalizeToolkitSlug('Google Calendar')).toBe('googlecalendar')
  })

  test('UI map covers featured connectors', () => {
    expect(UI_OR_SERVICE_TO_COMPOSIO.calendar).toBe('googlecalendar')
    expect(UI_OR_SERVICE_TO_COMPOSIO.drive).toBe('googledrive')
  })

  test('featured lists respect deny', () => {
    expect(featuredToolkits('friend')).not.toContain('stripe')
    expect(featuredToolkits('coworker')).toContain('slack')
  })
})
