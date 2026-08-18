import type { ConnectorId } from './connectors'

export type OnboardStep =
  | 'contract'
  | 'identity'
  | 'location'
  | 'homework'
  | 'time'
  | 'priorities'
  | 'proof'
  | 'connectors'
  | 'proactive'
  | 'stage2'
  | 'done'
  | 'skipped'

export type ResponseStyle = 'concise' | 'balanced' | 'chatty'
export type PriorityId = 'food' | 'plans' | 'travel' | 'reminders' | 'support' | 'email' | 'fitness'

export interface ProactiveSettings {
  enabled: boolean
  checkInFrequency: 'off' | 'daily' | 'weekly'
  digest: boolean
  reminderCategories: string[]
  pausedToday: boolean
  everythingOff: boolean
}

export interface OnboardingProgress {
  stage: 0 | 1 | 2
  currentStep: OnboardStep
  identity: { name: string; pronouns: string; focus: string }
  locationDone: boolean
  homeDone: boolean
  workDone: boolean
  timezone: string
  quietStart: string
  quietEnd: string
  responseStyle: ResponseStyle
  followUps: boolean
  priorities: PriorityId[]
  connectorsSeen: boolean
  proactive: ProactiveSettings
  profile: Record<string, string>
  completedAt: string | null
  updatedAt: string
}

export const DEFAULT_QUIET_START = '22:00'
export const DEFAULT_QUIET_END = '08:00'

export function defaultOnboarding(): OnboardingProgress {
  return {
    stage: 0,
    currentStep: 'contract',
    identity: { name: '', pronouns: '', focus: '' },
    locationDone: false,
    homeDone: false,
    workDone: false,
    timezone: '',
    quietStart: DEFAULT_QUIET_START,
    quietEnd: DEFAULT_QUIET_END,
    responseStyle: 'balanced',
    followUps: true,
    priorities: [],
    connectorsSeen: false,
    proactive: {
      enabled: true,
      checkInFrequency: 'weekly',
      digest: true,
      reminderCategories: [],
      pausedToday: false,
      everythingOff: false,
    },
    profile: {},
    completedAt: null,
    updatedAt: new Date().toISOString(),
  }
}

const KEY = 'hirealpha-onboarding'

export function loadOnboarding(): OnboardingProgress {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultOnboarding()
    const parsed = JSON.parse(raw) as Partial<OnboardingProgress>
    const base = defaultOnboarding()
    return {
      ...base,
      ...parsed,
      identity: { ...base.identity, ...(parsed.identity ?? {}) },
      proactive: { ...base.proactive, ...(parsed.proactive ?? {}) },
      profile: { ...(parsed.profile ?? {}) },
      priorities: Array.isArray(parsed.priorities) ? (parsed.priorities as PriorityId[]) : [],
      updatedAt: new Date().toISOString(),
    }
  } catch {
    return defaultOnboarding()
  }
}

export function saveOnboarding(p: OnboardingProgress): OnboardingProgress {
  const next: OnboardingProgress = { ...p, updatedAt: new Date().toISOString() }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable — keep in memory */
  }
  return next
}

export function resetOnboarding(): OnboardingProgress {
  const fresh = defaultOnboarding()
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  return fresh
}

export function isOnboardingDone(): boolean {
  return loadOnboarding().currentStep === 'done'
}

export interface PriorityDef {
  id: PriorityId
  label: string
  emoji: string
}

export const PRIORITIES: PriorityDef[] = [
  { id: 'food', label: 'Food and restaurants', emoji: '🍜' },
  { id: 'plans', label: 'Plans and dates', emoji: '📆' },
  { id: 'travel', label: 'Travel and directions', emoji: '🧭' },
  { id: 'reminders', label: 'Reminders and routines', emoji: '⏰' },
  { id: 'support', label: 'Emotional support', emoji: '🫂' },
  { id: 'email', label: 'Email and calendar', emoji: '📬' },
  { id: 'fitness', label: 'Fitness and nutrition', emoji: '🥗' },
]

export const RESPONSE_STYLES: Array<{ id: ResponseStyle; label: string; hint: string }> = [
  { id: 'concise', label: 'Concise', hint: 'Short and to the point.' },
  { id: 'balanced', label: 'Balanced', hint: 'A little detail, no fluff.' },
  { id: 'chatty', label: 'Chatty', hint: 'Casual, like a friend.' },
]

export interface ProofAction {
  title: string
  line: string
  /** Real feature route to deep-link when one exists; empty string = no fake result. */
  href?: string
}

export const PROOF_BY_PRIORITY: Record<PriorityId, ProofAction> = {
  food: {
    title: 'Find a coffee shop near you',
    line: "Alpha searches near the location you saved and texts back one answer — the closest place that fits what you asked for.",
  },
  plans: {
    title: 'Suggest a plan around you',
    line: "Alpha uses your saved Home or current location to suggest one plan, not a menu.",
  },
  travel: {
    title: 'Get directions that fit your day',
    line: "Alpha picks the route that makes sense for where you are and where you are going.",
  },
  reminders: {
    title: 'Set a test reminder',
    line: "Alpha turns a short text into a reminder with the right time, and confirms it back.",
  },
  support: {
    title: 'Know Alpha is there for the rough days',
    line: "Alpha checks in and reads the room. No scripts, no taglines.",
  },
  email: {
    title: 'See what connecting gives you',
    line: "Connect Gmail or Calendar to get mail and meeting summaries in your texts. Nothing connects until you say so.",
    href: '/app/setup?step=connectors',
  },
  fitness: {
    title: 'Open the nutrition card',
    line: "Snap a meal, see macros, hit your daily goals. This card is live now.",
    href: '/app/mini/friend/nutrition',
  },
}

export interface ProfileField {
  id: string
  label: string
  benefit: string
  placeholder: string
  multiline?: boolean
}

export const PROFILE_FIELDS: ProfileField[] = [
  {
    id: 'cuisines',
    label: 'Favorite cuisines',
    benefit: 'So Alpha can recommend places you will like.',
    placeholder: 'Thai, Mexican, pizza, …',
  },
  {
    id: 'dietary',
    label: 'Dietary restrictions',
    benefit: 'Alpha skips places that do not work for you.',
    placeholder: 'Vegetarian, no shellfish, …',
  },
  {
    id: 'budget',
    label: 'Budget for meals out',
    benefit: 'Recommendations fit your range.',
    placeholder: 'Under $30 a meal',
  },
  {
    id: 'neighborhoods',
    label: 'Favorite neighborhoods',
    benefit: 'Plans land where you like to be.',
    placeholder: 'SoMa, Mission, …',
  },
  {
    id: 'avoid',
    label: 'Places to avoid',
    benefit: 'Alpha will not send you there.',
    placeholder: 'Airports on Fridays, …',
  },
  {
    id: 'work_hours',
    label: 'Home / work hours',
    benefit: 'Alpha knows when you are free.',
    placeholder: 'Work 9–5, gym 6am',
  },
  {
    id: 'people',
    label: 'Important people',
    benefit: 'Alpha helps you stay in touch with the people you name.',
    placeholder: 'Mom, Alex, …',
    multiline: true,
  },
  {
    id: 'routines',
    label: 'Recurring routines',
    benefit: 'Alpha works them into your plans.',
    placeholder: 'Sunday meal prep, monthly dinner',
  },
  {
    id: 'checkins',
    label: 'Check-in style',
    benefit: 'Pulse check-ins fit your day.',
    placeholder: 'Light Sunday check-in',
  },
  {
    id: 'notifications',
    label: 'Notification channels',
    benefit: 'Important things reach you, noise stays quiet.',
    placeholder: 'Texts for urgent, digest for the rest',
  },
]

export const REMINDER_CATEGORIES = [
  'Friends',
  'Family',
  'Work',
  'Health',
  'Finances',
  'Errands',
]

/** Truthful per-connector access copy for the connector review step. */
export const CONNECTOR_ACCESS: Partial<Record<ConnectorId, { access: 'read' | 'read-write'; revoke: string }>> = {
  gmail: { access: 'read-write', revoke: 'Revoke email access any time in Settings.' },
  calendar: { access: 'read', revoke: 'Revoke calendar access any time in Settings.' },
  slack: { access: 'read-write', revoke: 'Revoke Slack access any time in Settings.' },
  notion: { access: 'read-write', revoke: 'Revoke Notion access any time in Settings.' },
  linear: { access: 'read-write', revoke: 'Revoke Linear access any time in Settings.' },
  github: { access: 'read', revoke: 'Revoke GitHub access any time in Settings.' },
  drive: { access: 'read', revoke: 'Revoke Drive access any time in Settings.' },
  figma: { access: 'read', revoke: 'Revoke Figma access any time in Settings.' },
  maps: { access: 'read', revoke: 'Revoke Maps access any time in Settings.' },
  spotify: { access: 'read', revoke: 'Revoke Spotify access any time in Settings.' },
  stripe: { access: 'read', revoke: 'Revoke Stripe access any time in Settings.' },
}

export const STAGE1_STEPS: Array<{ id: OnboardStep; label: string }> = [
  { id: 'identity', label: 'Identity' },
  { id: 'location', label: 'Location' },
  { id: 'homework', label: 'Home & work' },
  { id: 'time', label: 'Time & quiet hours' },
  { id: 'priorities', label: 'What to know first' },
  { id: 'proof', label: 'Your first action' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'proactive', label: 'Proactive controls' },
]
