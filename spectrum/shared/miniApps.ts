import type { AgentId } from '../../src/agents/types'
import { SKILLS } from './skills'

/**
 * Mini-app layer: turns named hire "mini apps" (approve_send, pick_slot,
 * digest, …) into real iMessage App cards via Spectrum's `app()` content.
 * The card is a URL that opens in the Messages conversation through the
 * Spectrum launcher; the dashboard serves the matching page at
 * /app/mini/{persona}/{kind}.
 */

export type MiniAppKind =
  | 'menu'
  | 'digest'
  | 'approve_send'
  | 'pick_slot'
  | 'pick_night'
  | 'check_in'
  | 'standup_paste'
  | 'linear_triage'
  | 'kill_keep_park'
  | 'hire_decision'
  | 'weekly_focus'
  | 'approve_investor_note'
  | 'spiral_options'
  | 'open_loops'
  | 'meeting_mode'
  | 'decision_ledger'
  | 'relationship_radar'
  | 'drop_zone'
  | 'nutrition'
  | 'habit_streak'
  | 'mood_tracker'
  | 'workout_log'
  | 'learning_queue'
  | 'weekly_review'
  | 'networking_crm'
  | 'sleep_tracker'
  | 'pipeline_board'
  | 'gratitude_journal'
  | 'spending_snapshot'
  | 'mirror'

export interface MiniAppCard {
  url: string
  live: boolean
}

/**
 * Marker stored as a reminder prefix when a user asks for a recurring brief
 * ("remind me every morning to send my daily brief"). At fire time the
 * scheduler swaps it for the real generated briefing. Prefix-only matching
 * keeps ordinary reminders that happen to mention "brief" untouched.
 */
export const DIGEST_MARKER = '[digest]'

const DIGEST_INTENT =
  /\b(?:morning|daily|evening|night)\s+(?:brief|debrief|digest|recap)\b|\b(?:brief|debrief|recap)\s+me\b|\bdebrief\b|^brief\b|^digest\b|^start my day\b|\bcatch me up\b|\bwrap(?: me)? up\b|\bend of (?:the )?day\b|\beod\b|\bfull (?:day )?wrap\b/i

export function looksLikeDigestIntent(text: string): boolean {
  return DIGEST_INTENT.test(text)
}

/** "yes" / "ok" after Alpha offered a debrief still means the full day wrap. */
export function looksLikeAffirmedBrief(text: string, lastAssistant?: string): boolean {
  if (!lastAssistant || !/\bdebrief\b/i.test(lastAssistant)) return false
  return /^(yes|yeah|yep|y|ok|okay|sure|do it|please|go|debrief)\b/i.test(text.trim())
}

export function isDigestRequest(text: string): boolean {
  return text.startsWith(DIGEST_MARKER)
}

const PATTERNS: Partial<Record<MiniAppKind, RegExp>> = {
  digest: DIGEST_INTENT,
  check_in: /\bcheck[\s-]?in\b/i,
  approve_send: /\bapprove\b|\bsend (?:that|this|the) (?:email|draft|note)\b|\bfire (?:that|this|the) (?:email|draft)\b|\bready to send\b/i,
  pick_slot: /\b(?:pick|find|suggest|choose)\b.{0,20}\b(?:slot|time|window)\b|\bwhen should we\b|\bwhat time works\b/i,
  pick_night: /\btonight\b|\bwhat should we do\b|\bdinner plans\b|\bdate night\b|\b(?:pick|plan)\b.{0,24}\b(?:movie|place|restaurant|hang)\b/i,
  standup_paste: /\bstand-?ups?\b|\bwhat did i (?:do|get done)\b/i,
  linear_triage: /\btriage\b|\blinear\b|\bbacklog\b/i,
  kill_keep_park: /\bkill[\s-]?keep[\s-]?park\b|\bwhat should (?:we|i) (?:kill|keep|park)\b/i,
  hire_decision: /\bhire\b.{0,16}\b(?:decision|call)\b|\bhire or pass\b|\bshould we hire\b|\bmake the (?:hiring )?call\b/i,
  weekly_focus: /\bweekly focus\b|\bthis week[’']?s focus\b|\bfocus (?:for|this) week\b|\bpriorities this week\b/i,
  approve_investor_note: /\binvestor (?:note|update)\b|\bterm sheet\b|\bfundrais(?:e|ing)\b/i,
  spiral_options: /\bspiral(?:ing)?\b|\boptions\b/i,
  open_loops: /\bopen loop\b|\b(?:forgot|forget|remember) (?:to|that)\b|\b(?:owed|i owe|promised|told \w+ i.?d)\b|\bfollow[- ]?up (?:list|open)\b/i,
  meeting_mode: /\b(?:meeting|call|1[-: ]?1|sync|interview)\b.{0,16}\b(?:prep|brief|debrief|notes|follow[- ]?up)\b|\bprep (?:me|for)\b|\bafter (?:the )?(?:meeting|call)\b/i,
  decision_ledger: /\bdecision\b.{0,16}\b(?:log|record|ledger|journal)\b|\blog (?:that|this|a) decision\b|\bwhat did (?:we|i) decide\b/i,
  relationship_radar: /\brelationship radar\b|\b(?:haven.?t|need to) (?:reach|touch|check) (?:out|in|base)\b|\bwho should i (?:follow|reach|check)\b/i,
  drop_zone: /\bdrop zone\b|\bdump (?:this|that|it|a)\b|\bsave (?:this|that|it) for (?:later|me)\b|\broute (?:this|that|it)\b/i,
  nutrition: /\b(?:what|how many) (?:did i eat|calories|protein|macros)\b|\b(?:log|track) (?:my )?(?:food|meal|lunch|dinner|breakfast|snack)\b|\bmacros?\b|\bcalorie\b|\bi ate\b/i,
  habit_streak: /\bhabit streak\b|\b(?:log|track) (?:my )?habits?\b|\bmark .{0,20}(?:done|habit)\b/i,
  mood_tracker: /\b(?:log|track) (?:my )?mood\b|\bhow(?:'s| is) my (?:mood|energy)\b|\bmood tracker\b/i,
  workout_log: /\bworkout log\b|\b(?:log|track) (?:my )?(?:workout|lift|gym|sets)\b|\bbench press\b|\bhow much (?:did i|can i) lift\b/i,
  learning_queue: /\blearning queue\b|\bsave (?:this|that) (?:article|video|podcast|to (?:my )?queue)\b|\bwhat should i (?:read|watch|listen)\b/i,
  weekly_review: /\bweekly (?:review|recap|focus)\b|\bhow was (?:my )?week\b|\bwhat (?:got done|slipped) this week\b/i,
  networking_crm: /\bnetworking\b|\bi met\b|\bfollow up with\b|\bwho should i follow up\b/i,
  sleep_tracker: /\bsleep tracker\b|\b(?:log|track) (?:my )?sleep\b|\bhow (?:did i|long did i) sleep\b|\bsleep debt\b/i,
  pipeline_board: /\bpipeline\b|\b(?:job|deal|lead) (?:board|pipeline|status)\b|\bmove .{0,20}to (?:interview|offer)\b/i,
  gratitude_journal: /\bgratitude\b|\b(?:i'?m|i am) grateful\b|\bgrateful for\b/i,
  spending_snapshot: /\bspending snapshot\b|\b(?:log|track) (?:my )?(?:spend|spending|expense)\b|\bhow much (?:did i|have i) spent\b|\bweekly budget\b/i,
  mirror: /\bmirror\b|\blife dashboard\b|\bhow(?:'s| is) my life (?:going|looking)\b|\breflect on my (?:week|life)\b|\bshow me (?:the )?(?:week|life)\b/i,
}

export interface MiniAppRequest {
  kind: MiniAppKind
  query?: Record<string, string>
}

/** Kinds this hire may surface, product-order from skills.ts plus digest. */
function allowedKinds(persona: AgentId): MiniAppKind[] {
  const named = SKILLS[persona]?.miniApps ?? []
  return ['digest', ...named.filter((k): k is MiniAppKind => k in PATTERNS)]
}

/** Cheap regex gate so we only attach a card when the message asks for one. */
export function detectMiniAppRequest(
  userText: string,
  persona: AgentId,
): MiniAppRequest | null {
  for (const kind of allowedKinds(persona)) {
    if (PATTERNS[kind]?.test(userText)) return { kind }
  }
  return null
}

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

function authHeaders() {
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  return {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

export function miniAppUrl(
  persona: AgentId,
  kind: MiniAppKind,
  query?: Record<string, string>,
): string {
  const base = apiBase() || 'https://hirealpha.chat'
  const url = new URL(`${base}/app/mini/${persona}/${kind}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  }
  return url.toString()
}

/** The content `app()` card to deliver with a text reply. */
export function miniAppCard(
  persona: AgentId,
  kind: MiniAppKind,
  query?: Record<string, string>,
): MiniAppCard {
  // Keep the bubble tappable on iMessage. The live extension preview is
  // clipped on some clients instead of expanding to the full mini-app.
  return { url: miniAppUrl(persona, kind, query), live: false }
}

/**
 * Mint a short-lived, signed URL for a mini-app card so it works inside the
 * Messages webview without a browser session. Falls back to the unsigned URL
 * when the API is unreachable, so a card is always delivered.
 */
export async function mintMiniAppUrl(
  phone: string,
  persona: AgentId,
  kind: MiniAppKind,
  query?: Record<string, string>,
): Promise<string> {
  const base = apiBase()
  if (base) {
    try {
      const qs = new URLSearchParams({ phone, persona, kind })
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 4000)
      const res = await fetch(`${base}/api/internal/mini/token?${qs}`, {
        headers: authHeaders(),
        signal: ctrl.signal,
      })
      clearTimeout(t)
      if (res.ok) {
        const data = (await res.json()) as { url?: string }
        if (data.url) return data.url
      }
    } catch (err) {
      console.warn('[miniApps] token mint failed, falling back to unsigned URL', err)
    }
  }
  return miniAppUrl(persona, kind, query)
}

/** Minted card builder used by runHireTurn and the digest scheduler. */
export async function mintMiniAppCard(
  phone: string,
  persona: AgentId,
  kind: MiniAppKind,
  query?: Record<string, string>,
): Promise<MiniAppCard> {
  return { url: await mintMiniAppUrl(phone, persona, kind, query), live: false }
}

/**
 * Onboarding chooser card sent on a user's very first text to a hire.
 * The page lists the features that hire can do and lets the user pick;
 * picks are stored via /api/setup so the bot sees them as context.
 */
export async function onboardingCard(phone: string, persona: AgentId): Promise<MiniAppCard> {
  return mintMiniAppCard(phone, persona, 'menu')
}

/**
 * Generate the text of a daily briefing plus the live card that opens the
 * matching dashboard view. The text doubles as the plain-SMS fallback when
 * the recipient has no app card support.
 */
export async function buildDigestBriefing(
  phone: string,
  persona: AgentId,
): Promise<{ text: string; card: MiniAppCard } | null> {
  const base = apiBase()
  if (!base) return null
  try {
    const res = await fetch(
      `${base}/api/internal/digest?phone=${encodeURIComponent(phone)}&persona=${encodeURIComponent(persona)}`,
      { headers: authHeaders() },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { text?: string; cardUrl?: string }
    const text = data.text?.trim()
    if (!text) return null
    return {
      text,
      card: await mintMiniAppCard(phone, persona, 'digest'),
    }
  } catch (err) {
    console.warn(`[miniApps] digest brief failed for ${persona}`, err)
    return null
  }
}
