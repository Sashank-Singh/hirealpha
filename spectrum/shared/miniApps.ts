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
  | 'apps'
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
  | 'next_move'

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

export const PATTERNS: Partial<Record<MiniAppKind, RegExp>> = {
  apps: /^(?:apps|store)$|\b(?:app store|mini[- ]?apps?|my apps)\b|\b(?:open|show|pull up|bring back) (?:my |the )?(?:apps|app store|store)\b|\bapps\b/i,
  digest: DIGEST_INTENT,
  next_move:
    /\b(?:what(?:'?s| is) next|next move|do this now|clear (?:my )?inbox)\b|\b(?:open|show|pull up|bring back) (?:my |the )?next\b/i,
  check_in: /\b(?:quick )?check[\s-]?in\b/i,
  approve_send: /\bapprove\b|\bsend (?:that|this|the) (?:email|draft|note)\b|\bfire (?:that|this|the) (?:email|draft)\b|\bready to send\b/i,
  pick_slot: /\b(?:pick|find|suggest|choose)\b.{0,20}\b(?:slot|time|window)\b|\bwhen should we\b|\bwhat time works\b/i,
  pick_night: /\btonight\b|\bwhat should we do\b|\bdinner plans\b|\bdate night\b|\b(?:pick|plan)\b.{0,24}\b(?:movie|place|restaurant|hang)\b|\bevening brief\b|\bwind[- ]?down\b|\beod\b|\bend of (?:the )?day\b|\bday (?:recap|wrap)\b|\bevening recap\b/i,
  standup_paste: /\bstand-?ups?\b|\bwhat did i (?:do|get done)\b/i,
  linear_triage: /\btriage\b|\blinear\b|\bbacklog\b/i,
  kill_keep_park: /\bkill[\s-]?keep[\s-]?park\b|\bwhat should (?:we|i) (?:kill|keep|park)\b/i,
  hire_decision: /\bhire\b.{0,16}\b(?:decision|call)\b|\bhire or pass\b|\bshould we hire\b|\bmake the (?:hiring )?call\b/i,
  weekly_focus: /\bweekly focus\b|\bthis week[’']?s focus\b|\bfocus (?:for|this) week\b|\bpriorities this week\b/i,
  approve_investor_note: /\binvestor (?:note|update)\b|\bterm sheet\b|\bfundrais(?:e|ing)\b/i,
  spiral_options: /\bspiral(?:ing)?\b/i,
  open_loops: /\bopen loop\b|\b(?:forgot|forget|remember) (?:to|that)\b|\b(?:owed|i owe|promised|told \w+ i.?d)\b|\bfollow[- ]?up (?:list|open)\b/i,
  meeting_mode: /\b(?:meeting|call|1[-: ]?1|sync|interview)\b.{0,16}\b(?:prep|brief|debrief|notes|follow[- ]?up)\b|\bprep (?:me|for)\b|\bafter (?:the )?(?:meeting|call)\b/i,
  decision_ledger: /\bdecision\b.{0,16}\b(?:log|record|ledger|journal)\b|\blog (?:that|this|a) decision\b|\bwhat did (?:we|i) decide\b/i,
  relationship_radar: /\brelationship radar\b|\b(?:haven.?t|need to) (?:reach|touch|check) (?:out|in|base)\b|\bwho should i (?:follow|reach|check)\b/i,
  // drop_zone intentionally does NOT match save+URL combos; the URL gate in detectMiniAppRequest routes those to learning_queue first
  drop_zone: /\bdrop zone\b|\bdump (?:this|that|it|a)\b|\bsave (?:this |that |it )?for (?:later|me)\b|\broute (?:this|that|it)\b|\b(?:open|show|pull up|bring back) (?:my |the )?drop zone\b/i,
  nutrition:
    /\bnutrition\b|\b(?:what|how many) (?:did i eat|calories|protein|macros)\b|\b(?:log|track) (?:my )?(?:food|meal|lunch|dinner|breakfast|snack)\b|\bmacros?\b|\bcalorie\b|\bi ate\b|\b(?:open|show|pull up|bring back) (?:my |the )?nutrition\b/i,
  // habit_streak: explicit name + reopen
  habit_streak:
    /\bhabit(?: streak| tracker)?\b|\b(?:log|track) (?:my )?habits?\b|\bmark .{0,20}(?:done|habit)\b|\b(?:open|show|pull up|bring back) (?:my )?habits?\b|\bmy streak\b/i,
  // mood_tracker: explicit name + reopen + pull up mood
  mood_tracker:
    /\b(?:log|track) (?:my )?mood\b|\bhow(?:'s| is) my (?:mood|energy)\b|\bmood (?:tracker|check|log|card)\b|\bmood check\b|\b(?:open|show|pull up|bring back) (?:my |the )?mood(?: tracker)?\b/i,
  // workout_log: explicit name + reopen + natural phrases
  workout_log:
    /\bworkout(?: log)?\b|\b(?:log|track) (?:my )?(?:workout|lift|gym|sets)\b|\bbench press\b|\bhow much (?:did i|can i) lift\b|\bi (?:worked out|went to the gym|lifted)\b|\b(?:open|show|pull up|bring back) (?:my )?workout(?: log)?\b|\bmy lifts\b/i,
  // learning_queue: explicit name + reopen + save-article phrases (URL gate in detectMiniAppRequest handles URL+save)
  learning_queue:
    /\blearning queue\b|\bmy (?:reading |watch )?list\b|\bmy (?:learning )?queue\b|\bwhat should i (?:read|watch|listen)\b|\bsave (?:this|that) (?:article|video|podcast|link|post|thread)\b|\bsave this link\b|\badd (?:this|that|it) to (?:my )?(?:queue|reading list|watch list|learning)\b|\b(?:open|show|pull up|bring back) (?:my |the )?(?:learning(?: queue)?|reading list|queue)\b|\bwhat.?s in my (?:learning )?queue\b/i,
  // weekly_review: explicit name + reopen + natural end-of-week phrases
  weekly_review:
    /\bweekly (?:review|recap|focus)\b|\bhow was (?:my )?week\b|\bwhat (?:got done|slipped) this week\b|\b(?:open|show|pull up|bring back) (?:my )?weekly review\b|\breview (?:my )?week\b|\bend of (?:the )?week\b/i,
  // networking_crm: explicit name + reopen + natural contact phrases
  networking_crm:
    /\bnetwork(?:ing)?(?: crm)?\b|\bi (?:met|ran into|bumped into)\b|\badd .{1,30} to (?:my )?(?:network|contacts|networking)\b|\bfollow(?:ing)? up with\b|\bwho should i follow up\b|\breconnect with\b|\bneed to reach out to\b|\badd a contact\b|\bmy contacts\b|\bnew contact\b|\b(?:open|show|pull up|bring back) (?:my |the )?network(?:ing)?(?: crm)?\b/i,
  // sleep_tracker: explicit name + reopen + natural phrases including "log last night"
  sleep_tracker:
    /\bsleep(?: tracker)?\b|\b(?:log|track) (?:my )?sleep\b|\bhow (?:did i|long did i) sleep\b|\bsleep debt\b|\bsleep last night\b|\blast night.{0,20}sleep\b|\bslept .{0,10}hours\b|\bwoke up at\b|\bbed(?:time)? at\b|\b(?:open|show|pull up|bring back) (?:my )?sleep(?: tracker)?\b/i,
  // pipeline_board: explicit name + reopen + job/deal phrases
  pipeline_board:
    /\bpipeline(?: board)?\b|\b(?:job|deal|lead) (?:board|pipeline|status)\b|\bmove .{0,20}to (?:interview|offer)\b|\bapplication status\b|\bjob board\b|\b(?:open|show|pull up|bring back) (?:my )?pipeline\b/i,
  // gratitude_journal: explicit name + reopen + natural phrases
  gratitude_journal:
    /\bgratitude(?: journal)?\b|\b(?:i'?m|i am) grateful\b|\bgrateful for\b|\blog (?:my )?gratitude\b|\b(?:open|show|pull up|bring back) (?:my )?gratitude(?: journal)?\b/i,
  // spending_snapshot: explicit name + reopen + "I spent" + expense phrases
  spending_snapshot:
    /\bspending(?: snapshot| tracker)?\b|\b(?:log|track) (?:my )?(?:spend(?:ing)?|expense)\b|\bhow much (?:did i|have i) spent?\b|\bweekly budget\b|\bexpense log\b|\bi spent\b|\b(?:open|show|pull up|bring back) (?:my |the )?(?:spending|expenses?)\b/i,
  // mirror: explicit name + reopen + life overview phrases
  mirror:
    /\bmirror\b|\blife dashboard\b|\bhow(?:'s| is) my life (?:going|looking)\b|\breflect on my (?:week|life)\b|\bshow me (?:the )?(?:week|life)\b|\blife overview\b|\bhow am i doing overall\b|\b(?:open|show|pull up|bring back) (?:my )?(?:mirror|life dashboard)\b/i,
}

export interface MiniAppRequest {
  kind: MiniAppKind
  query?: Record<string, string>
}

/** Short labels for local fallback copy. No hyphens or dashes. */
const KIND_LABELS: Record<MiniAppKind, string> = {
  menu: 'setup',
  apps: 'Apps',
  digest: 'Morning brief',
  approve_send: 'Approve and send',
  pick_slot: 'Pick a slot',
  pick_night: 'Evening brief',
  check_in: 'Check in',
  standup_paste: 'Standup',
  linear_triage: 'Linear triage',
  kill_keep_park: 'Kill keep park',
  hire_decision: 'Hire decision',
  weekly_focus: 'Weekly focus',
  approve_investor_note: 'Investor note',
  spiral_options: 'Options',
  open_loops: 'Promises',
  meeting_mode: 'Meeting mode',
  decision_ledger: 'Decisions',
  relationship_radar: 'Stay in touch',
  drop_zone: 'Save for later',
  nutrition: 'Nutrition',
  habit_streak: 'Habits',
  mood_tracker: 'Mood',
  workout_log: 'Workout',
  learning_queue: 'Learning Queue',
  weekly_review: 'Weekly review',
  networking_crm: 'Networking',
  sleep_tracker: 'Sleep',
  pipeline_board: 'Pipeline',
  gratitude_journal: 'Gratitude',
  spending_snapshot: 'Spending',
  mirror: 'Mirror',
  next_move: 'Next',
}

export function miniAppFallbackText(kind: MiniAppKind): string {
  return `Here is your ${KIND_LABELS[kind] || 'mini app'} card.`
}

/**
 * Names people type when they want the card back. Matched only after a summon
 * verb ("pull up", "show me", "open") or a "… card" phrase.
 */
const SUMMON_NAMES: Partial<Record<MiniAppKind, RegExp>> = {
  apps: /\b(?:apps|app store|store|mini[- ]?apps?)\b/i,
  digest: /\b(?:morning |daily |evening )?(?:brief|digest|debrief)\b/i,
  nutrition: /\bnutrition\b|\bfood log\b|\bmeal log\b|\bmacros?\b/i,
  networking_crm: /\bnetwork(?:ing)?(?:\s*crm)?\b|\bpeople\b/i,
  mood_tracker: /\bmood(?:\s*(?:tracker|check|log))?\b/i,
  spending_snapshot: /\bspend(?:ing)?\b|\bexpenses?\b/i,
  sleep_tracker: /\bsleep(?:\s*tracker)?\b/i,
  workout_log: /\bworkout(?:\s*log)?\b|\blifts?\b/i,
  habit_streak: /\bhabits?(?:\s*(?:streak|tracker))?\b/i,
  weekly_review: /\bweekly review\b|\bweek(?:ly)? recap\b/i,
  learning_queue: /\blearning(?:\s*queue)?\b|\breading list\b|\bwatch list\b/i,
  pipeline_board: /\bpipeline(?:\s*board)?\b/i,
  gratitude_journal: /\bgratitude(?:\s*journal)?\b/i,
  drop_zone: /\bdrop zone\b|\bsave for later\b/i,
  mirror: /\bmirror\b|\blife dashboard\b/i,
  check_in: /\bcheck[\s-]?in\b/i,
  pick_night: /\btonight\b|\bdate night\b/i,
  open_loops: /\bopen loops?\b|\bloose ends\b|\bpromises?\b/i,
  relationship_radar: /\brelationship radar\b|\bstay in touch\b/i,
  next_move: /\bnext(?:\s*move)?\b|\bdo this now\b/i,
  approve_send: /\bapprove(?: and send)?\b|\bsend (?:that|this|the) (?:email|draft)\b/i,
  pick_slot: /\bpick (?:a )?slot\b|\bfind a time\b/i,
  linear_triage: /\blinear\b|\btriage\b/i,
  meeting_mode: /\bmeeting mode\b/i,
}

const SUMMON_VERB =
  /\b(?:open|show(?:\s+me)?|pull\s+up|bring\s+(?:back|up)|gimme|give\s+me)\b/i
const SHOW_CARD = /\bshow me (?:the |my |a )?.{0,40}?card\b/i
const NAMED_CARD = /\b(?:the|my)\s+.{0,40}?\s+card\b/i
const SAVE_INTENT =
  /\b(?:save|queue|bookmark|for later|read later|watch later|catch up on|come back to)\b|\badd\b.{0,24}\b(?:queue|reading list|watch list|learning)\b/i

export function looksLikeCardSummon(text: string): boolean {
  return SUMMON_VERB.test(text) || SHOW_CARD.test(text) || NAMED_CARD.test(text)
}

export function findUrlInTexts(texts: string[]): string | undefined {
  for (let i = texts.length - 1; i >= 0; i--) {
    const m = texts[i]?.match(/https?:\/\/\S+/i)
    if (m?.[0]) return m[0].replace(/[),.;]+$/, '')
  }
}

function detectSummonedKind(text: string, allowed: MiniAppKind[]): MiniAppKind | null {
  if (!looksLikeCardSummon(text)) return null
  for (const kind of allowed) {
    if (SUMMON_NAMES[kind]?.test(text)) return kind
  }
  return null
}

/** Kinds this hire may surface, product-order from skills.ts plus digest. */
function allowedKinds(persona: AgentId): MiniAppKind[] {
  const named = SKILLS[persona]?.miniApps ?? []
  return ['digest', 'apps', ...named.filter((k): k is MiniAppKind => k in PATTERNS)]
}

/** Cheap regex gate so we only attach a card when the message asks for one. */
export function detectMiniAppRequest(
  userText: string,
  persona: AgentId,
  recentUserTexts: string[] = [],
): MiniAppRequest | null {
  const allowed = allowedKinds(persona)
  const haystack = [userText, ...recentUserTexts].join('\n')

  // A URL paired with any save/queue/bookmark intent always routes to learning_queue,
  // regardless of where drop_zone falls in the persona ordering. The URL may live
  // in this bubble or a recent one (rich link, then "save this link").
  if (allowed.includes('learning_queue') && SAVE_INTENT.test(userText) && /https?:\/\/\S+/i.test(haystack)) {
    return { kind: 'learning_queue' }
  }
  // Article/video/podcast language + save intent also routes to learning_queue even without a URL.
  if (
    allowed.includes('learning_queue') &&
    /\b(?:article|video|podcast|blog post?|episode|link)\b/i.test(userText) &&
    /\b(?:save|queue|bookmark|add|for later|read later|watch later)\b/i.test(userText)
  ) {
    return { kind: 'learning_queue' }
  }

  const summoned = detectSummonedKind(userText, allowed)
  if (summoned) return { kind: canonicalMiniAppKind(persona, summoned) }

  for (const kind of allowed) {
    if (PATTERNS[kind]?.test(userText)) return { kind: canonicalMiniAppKind(persona, kind) }
  }
  return null
}

/** Dead kinds still resolve so old card URLs and regexes land on a living app. */
const KIND_ALIASES: Partial<Record<MiniAppKind, MiniAppKind>> = {
  relationship_radar: 'networking_crm',
  check_in: 'mirror',
  weekly_focus: 'weekly_review',
  spiral_options: 'next_move',
  gratitude_journal: 'habit_streak',
}

export function canonicalMiniAppKind(_persona: AgentId, kind: MiniAppKind): MiniAppKind {
  return KIND_ALIASES[kind] ?? kind
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
  kind = canonicalMiniAppKind(persona, kind)
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
  kind = canonicalMiniAppKind(persona, kind)
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
  return mintMiniAppCard(phone, persona, 'next_move')
}

/**
 * Generate the text of a daily briefing plus the live card that opens the
 * matching dashboard view. The text doubles as the plain-SMS fallback when
 * the recipient has no app card support.
 */
export async function buildDigestBriefing(
  phone: string,
  persona: AgentId,
): Promise<{ text: string; preview?: string; card: MiniAppCard } | null> {
  const base = apiBase()
  if (!base) return null
  try {
    const res = await fetch(
      `${base}/api/internal/digest?phone=${encodeURIComponent(phone)}&persona=${encodeURIComponent(persona)}`,
      { headers: authHeaders() },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { text?: string; preview?: string; cardUrl?: string }
    const text = data.text?.trim()
    if (!text) return null
    return {
      text,
      preview: data.preview?.trim() || undefined,
      card: await mintMiniAppCard(phone, persona, 'digest'),
    }
  } catch (err) {
    console.warn(`[miniApps] digest brief failed for ${persona}`, err)
    return null
  }
}
