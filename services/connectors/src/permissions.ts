import type { Persona, Service } from './types'

/**
 * Default persona permissions seeded on connect.
 * Stripe is HARD-DENIED for Friend regardless of this map (see enforceHardRules).
 */
export const DEFAULT_ENABLED_ON_CONNECT: Record<Persona, ReadonlySet<Service>> = {
  coworker: new Set([
    'google_calendar',
    'gmail',
    'slack',
    'notion',
    'linear',
    'github',
    'google_drive',
    'figma',
  ]),
  cofounder: new Set([
    'google_calendar',
    'gmail',
    'slack',
    'notion',
    'google_drive',
    'stripe',
  ]),
  friend: new Set(['google_calendar', 'spotify', 'uber', 'google_maps']),
}

/** Hardcoded: Stripe must never default-enable (or force-enable) for Friend. */
export function isHardDenied(persona: Persona, service: Service): boolean {
  return persona === 'friend' && service === 'stripe'
}

export function defaultEnabledFor(persona: Persona, service: Service): boolean {
  if (isHardDenied(persona, service)) return false
  return DEFAULT_ENABLED_ON_CONNECT[persona].has(service)
}

/** Tools that mutate external state and require explicit user confirmation. */
export const WRITE_TOOLS = new Set([
  'gmail.send',
  'gmail.draft_send',
  'calendar.create_event',
  'calendar.update_event',
  'calendar.delete_event',
  'slack.post_message',
  'slack.update_message',
  'notion.create_page',
  'notion.update_page',
  'linear.create_issue',
  'linear.update_issue',
  'github.create_pr_comment',
  'stripe.charge',
  'stripe.create_payment',
  'uber.request_ride',
])

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName) || toolName.endsWith('.write') || toolName.includes('.send')
}
