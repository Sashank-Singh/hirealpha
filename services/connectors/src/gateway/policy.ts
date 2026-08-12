import type { Persona } from '../types'

/**
 * Composio toolkit slugs (lowercase) recommended / allowed per persona.
 * Friend is allowlist-strict. Coworker and cofounder use deny lists so the
 * full catalog stays open while hard rules still apply.
 */
export const PERSONA_FEATURED_TOOLKITS: Record<Persona, readonly string[]> = {
  friend: ['googlecalendar', 'spotify', 'uber', 'googlemaps', 'gmail'],
  coworker: [
    'googlecalendar',
    'gmail',
    'slack',
    'notion',
    'linear',
    'github',
    'googledrive',
    'figma',
  ],
  cofounder: ['googlecalendar', 'gmail', 'slack', 'notion', 'googledrive', 'stripe'],
}

/** Never allow these toolkits for a persona (hard policy). */
export const PERSONA_DENIED_TOOLKITS: Record<Persona, ReadonlySet<string>> = {
  friend: new Set([
    'stripe',
    'slack',
    'linear',
    'github',
    'figma',
    'notion',
    'salesforce',
    'hubspot',
  ]),
  coworker: new Set(['uber']),
  cofounder: new Set(['uber', 'spotify']),
}

/** Friend only: if set, catalog is filtered to this allowlist (+ featured). */
export const PERSONA_STRICT_ALLOWLIST: Partial<Record<Persona, ReadonlySet<string>>> = {
  friend: new Set([
    'googlecalendar',
    'gmail',
    'spotify',
    'uber',
    'googlemaps',
    'googmaps',
    'maps',
  ]),
}

/** Map HireAlpha UI / hand-rolled OAuth service ids → Composio toolkit slugs. */
export const UI_OR_SERVICE_TO_COMPOSIO: Record<string, string> = {
  calendar: 'googlecalendar',
  google_calendar: 'googlecalendar',
  gmail: 'gmail',
  slack: 'slack',
  notion: 'notion',
  linear: 'linear',
  github: 'github',
  drive: 'googledrive',
  google_drive: 'googledrive',
  spotify: 'spotify',
  stripe: 'stripe',
  figma: 'figma',
  maps: 'googlemaps',
  google_maps: 'googlemaps',
  uber: 'uber',
}

export function normalizeToolkitSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/[\s_]+/g, '')
}

export function isToolkitAllowed(persona: Persona, toolkitSlug: string): boolean {
  const slug = normalizeToolkitSlug(toolkitSlug)
  if (PERSONA_DENIED_TOOLKITS[persona].has(slug)) return false
  const allow = PERSONA_STRICT_ALLOWLIST[persona]
  if (allow && allow.size > 0) return allow.has(slug)
  return true
}

export function featuredToolkits(persona: Persona): string[] {
  return PERSONA_FEATURED_TOOLKITS[persona].filter((s) => isToolkitAllowed(persona, s))
}
