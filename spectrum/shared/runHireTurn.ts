import {
  getAgent,
  buildSystemPrompt,
  type AgentId,
} from '../../src/agents'
import { runAgentLocally } from '../../src/agents/runtime'
import { skillsPromptBlock, SKILLS } from './skills'
import { gmiChat } from './gmi'
import { appendThread, loadMemory, upsertFacts, pruneExpiredFacts, setSummary, trimHistory, MAX_RAW, type ThreadMemory } from './memory'
import { extractFacts, summarizeOld } from './memoryMaintain'
import { autoLogGratitude, autoLogHabit, autoLogMood, autoLogNutrition, autoLogSleep, autoLogSpend, autoLogWorkout, autoLogNetwork, autoSaveLearning, autoSetBudget, autoSetPrefs, fetchLiveProfile, fetchLiveTools, fetchMiniRun, fetchPrepBundle, fetchWeekBundle, formatHireContext, formatHireMemories, persistLiveFacts, proposeLiveDraft, touchInbound } from './liveContext'
import {
  looksLikeReminder,
  parseReminderIntent,
  createReminder,
  listReminders,
  localTimeToUtc,
} from './reminders'
import { setProactiveMode, fetchLastProactiveTopic, fetchJudgmentState } from './judgment'
import { formatLifeStateBlock } from './lifeState'
import {
  DIGEST_MARKER,
  detectMiniAppRequest,
  looksLikeAffirmedBrief,
  looksLikeDigestIntent,
  looksLikeEveningBriefIntent,
  mintMiniAppCard,
  miniAppFallbackText,
  buildDigestBriefing,
  type MiniAppCard,
  type MiniAppKind,
} from './miniApps'
import { foldQuotes, isBannedTagline, dropBannedTaglines } from './outboundFilter'
import { formatNowForAgent, pickUserTimezone, timezoneFromText } from '../../deploy/timezones'
import {
  looksLikeEventWrite,
  looksLikeFollowUp,
  looksLikeMailWrite,
  looksLikePrep,
  looksLikeWeekRun,
  classifyHardStop,
  classifyHumanLimit,
  hardStopInstruction,
  humanLimitInstruction,
  matchPerson,
  prepTarget,
  parseDraftCall,
  parseExtractedWrite,
  parsePlannerTool,
  parseToolCall,
  pingMail,
  stripToolDirectives,
  wantsOperatorWrite,
  TOOL_LOOP_INSTRUCTIONS,
  type DraftCall,
  type PersonHit,
} from './toolLoop'

export { isBannedTagline } from './outboundFilter'

export function splitBubbles(text: string): string[] {
  const cleaned = sanitizeOutbound(text.replace(/\r/g, ''))
  if (!cleaned) return []
  // Blank-line-separated paragraphs land as their own bubbles, so a multi-part
  // reply reads like a real back-and-forth instead of one long block.
  const blocks = cleaned
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean)
  return blocks.length > 1 ? blocks : [cleaned]
}

/** Card every text reply gets when the turn produced no specific one: the Apps
 * launcher, so a mini-app is always one tap below the last bubble. */
export async function defaultReplyCard(phone: string, persona: AgentId): Promise<MiniAppCard | null> {
  try {
    return await mintMiniAppCard(phone, persona, 'apps')
  } catch {
    return null
  }
}

const REASON =
  /(?:the (?:user|instructions)|instructions say|tool result|in context|connected as a tool|I (?:should|need to|have|will|am going|want to|can check the))|^Let me|^Wait,?|^First,?|^OK[,:]|^Alright[,:]|^So /i
const FIRST_MEET =
  /\b(good to meet you|nice to meet you|pleasure to meet you|great to meet you|glad to meet you)\b/gi

function isTheaterCopy(text: string): boolean {
  return isBannedTagline(text)
}

/** Drop leaked reasoning, banned taglines, and first-meet lines for returning people. */
function stripReasoning(text: string, returning = false): string {
  const paras = foldQuotes(text)
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  let firstReal = 0
  while (firstReal < paras.length && REASON.test(paras[firstReal]!)) firstReal++
  const kept = paras
    .slice(firstReal)
    .filter((p) => !isTheaterCopy(p))
    .map((p) => (returning ? p.replace(FIRST_MEET, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim() : p))
    .map((p) =>
      returning
        ? p
            .replace(/^(hey\s+\w+[.,]?\s*)?(good to meet you|nice to meet you)[^.!?]*[.!?]?\s*/i, '')
            .replace(/\bi'?m alpha,? your guy[^.!?]*[.!?]?\s*/i, '')
            .trim()
        : p,
    )
    .filter((p) => p.length > 8)
  return kept.join('\n\n').trim()
}

/** Agents never send hyphens, en dashes, or em dashes. Keep URLs and emails intact. */
export function stripDashes(text: string): string {
  const hold: string[] = []
  const stash = (s: string) => {
    hold.push(s)
    return `\0${hold.length - 1}\0`
  }
  let out = text
    .replace(/https?:\/\/[^\s]+/gi, stash)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, stash)
  out = out.replace(/[\u2014\u2015\u2013\u2212]/g, ', ')
  out = out.replace(/(\S) - (\S)/g, '$1, $2')
  out = out.replace(/^(\s*)[-*]\s+/gm, '$1')
  for (let i = 0; i < 8 && /(\w)-(\w)/.test(out); i++) {
    out = out.replace(/(\w)-(\w)/g, '$1 $2')
  }
  out = out.replace(/[ \t]{2,}/g, ' ')
  out = out.replace(/,\s*,+/g, ',')
  out = out.replace(/\s+([,.!?])/g, '$1')
  out = out.replace(/\0(\d+)\0/g, (_, i) => hold[Number(i)] || '')
  return out.trim()
}

/** Last pass before any iMessage send. */
export function sanitizeOutbound(text: string): string {
  const cleaned = stripDashes(dropBannedTaglines(text))
  if (!cleaned || isBannedTagline(cleaned)) return ''
  return cleaned
}

function wantsLiveData(text: string) {
  return /\b(e-?mails?|inbox|mail|gmail|unread|calendar|meeting|meetings|schedule|agenda|tomorrow|today|slack|notion|linear|github|drive|spotify|playlist|figma|stripe|revenue|dinner|restaurant|tonight|maps|place|places|ticket|backlog|triage|deck|wiki|look up|search|debrief|brief|recap|digest)\b/i.test(
    text,
  )
}

const BRIEF_TOOL_QUERY = 'calendar today tomorrow inbox important email debrief'

function maybeToolIntent(text: string) {
  return /\b(near(?: by)?|around|where\b|recommend|suggest|show me|find|search|look(?:ing|ing for| up| it up)|dinner|lunch|breakfast|eat|food|restaurant|cafe|bar|coffee|spot|place|tonight|weekend|date night|hangout|movie|weather|news|latest|price|how much|delivery|takeout|reservation|book|maps?|directions)\b/i.test(
    text,
  )
}

/** Semantic gate: no exact keyword required. Decides maps vs web vs none. */
async function classifyFreeLookup(
  message: string,
): Promise<{ tool: 'maps' | 'web' | 'none'; query: string } | null> {
  try {
    const raw = await gmiChat({
      temperature: 0,
      maxTokens: 60,
      messages: [
        {
          role: 'system',
          content:
            'You decide whether an iMessage wants a free live lookup (no app connector needed) and which one. MAPS = finding real places, venues, food, or transport nearby restaurants, cafes, bars, parks, directions, "near me", dinner spots. WEB = researching facts, news, prices, recipes, meanings, comparisons anything that needs the internet but is not about finding a location. If neither fits, or they are just chatting, pick none. Reply JSON only, exactly one of: {"tool":"maps"}, {"tool":"web"}, {"tool":"none"}. When tool is maps or web also include "query": the clean short search phrase you would type (e.g. {"tool":"maps","query":"restaurants in San Francisco"}).',
        },
        { role: 'user', content: message },
      ],
    })
    const tool = (raw.match(/"tool"\s*:\s*"(maps|web|none)"/) || [])[1] || ''
    if (!tool || tool === 'none') return { tool: 'none', query: '' }
    const query = (raw.match(/"query"\s*:\s*"([^"]+)"/) || [])[1] || message
    return { tool: tool as 'maps' | 'web', query }
  } catch {
    return null
  }
}

export function looksLikeNutritionLog(text: string) {
  return /\b(i ate|i had|log|track|meal|breakfast|lunch|dinner|snack|food)\b/i.test(text)
}

export function looksLikeWorkoutLog(text: string) {
  return /\d+\s*[x×]\s*\d+|\d+\s*sets?\s*(?:of\s*)?\d+/i.test(text)
}

export function looksLikeSleepLog(text: string) {
  return /\d{1,2}(?::\d{2})?\s*(am|pm)?\s*(?:-|–|to|until)\s*\d{1,2}/i.test(text)
}

export function looksLikeGratitudeLog(text: string) {
  return /grateful(?:\s+for)?\s*[:\-]?\s*\S+/i.test(text)
}

export function looksLikeSpendLog(text: string) {
  return /\$\s*\d+|(?:spent|spend|paid|cost)\s+\$?\s*\d+/i.test(text)
}

function looksLikeBudgetSet(text: string) {
  return /\bbudget\b/i.test(text) && /\d{2,6}/.test(text)
}

function looksLikePrefsSet(text: string) {
  const t = text.toLowerCase()
  if (
    /\b(?:set|change|update|switch|move to|make)\b/.test(t) &&
    /\b(?:workout\w*|train\w*|sleep|bedtime|wake|gym|home|moves?\b|saturdays?|sundays?)\b/.test(t)
  ) {
    return true
  }
  return (
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekends?|every day)\b/.test(t) &&
    /\b(?:workout\w*|train\w*|rest\s+day)\b/.test(t)
  )
}

function prefDaysLabel(days: number[]): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return days.map((d) => names[d] ?? d).join(', ')
}

function looksLikeLifeTap(text: string) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '')
  return /^(eat|skip|later|ok|okay|done|send|in|out|log|yes|yeah)\b/.test(t)
}

export function looksLikeMoodReply(text: string) {
  const t = text.trim()
  if (!t || t.length > 40) return false
  if (/^[😄🙂😐😔😤]+$/.test(t)) return true
  return /^(i'?m|i am)?\s*(good|fine|okay|ok|great|meh|tired|exhausted|sad|down|rough|bad|angry|stressed|frustrated|great!?)\b/i.test(t)
}

export function looksLikeHabitDone(text: string) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '')
  if (!t || t.length > 30) return false
  return /^(done|did|did it|yes|yeah|yep|y|ok|okay|sure|all done|did that)\b/.test(t)
}

const LIVE_MINI = new Set(['pick_night', 'tonight', 'standup_paste', 'kill_keep_park'])

const TOOL_HINT: Record<string, string> = {
  gmail: 'check my gmail inbox',
  calendar: 'what is on my calendar today',
  maps: 'quiet restaurant nearby tonight',
  slack: 'check slack',
  linear: 'linear issues backlog',
  notion: 'search notion docs',
  drive: 'list drive files',
  github: 'github issues assigned to me',
  figma: 'figma files',
  spotify: 'what is playing on spotify',
  stripe: 'stripe balance',
}

async function pickLiveTool(
  message: string,
  connected: string[],
  persona: AgentId,
): Promise<string | null> {
  const live = SKILLS[persona].executable.filter((t) => connected.includes(t))
  if (!live.length) return null
  try {
    const raw = await gmiChat({
      temperature: 0,
      maxTokens: 40,
      messages: [
        {
          role: 'system',
          content: `Pick at most one live tool for this iMessage. Live tools: ${live.join(', ')}. Reply JSON only: {"tool":"${live[0]}"} or {"tool":"none"}. If they are just talking, pick none.`,
        },
        { role: 'user', content: message },
      ],
    })
    const m = raw.match(/"tool"\s*:\s*"(\w+)"/)
    const tool = m?.[1] || ''
    if (!tool || tool === 'none' || !live.includes(tool)) return null
    return tool
  } catch {
    return null
  }
}

function buildMemoryBlock(
  mem: ThreadMemory,
  liveFacts: Array<{ key: string; value: string }>,
): string {
  const byKey = new Map<string, string>()
  for (const f of mem.facts) byKey.set(f.key, f.value)
  for (const f of liveFacts) byKey.set(f.key, f.value)
  const merged = [...byKey.entries()].slice(0, 12)
  const facts = merged.length ? merged.map(([k, v]) => `${k}: ${v}`).join('\n') : ''
  const summary = mem.summary.trim()
  const parts: string[] = []
  if (facts) parts.push(`## Known facts about this person\n${facts}`)
  if (summary) parts.push(`## Memory of past conversations\n${summary}`)
  return parts.join('\n\n')
}

/** Handle stop/pause/resume proactive and quiet hours in one turn. */
function looksLikeProactiveControl(text: string): boolean {
  const t = foldQuotes(text)
  return (
    /\bquiet hours\b/i.test(t) ||
    /\b(stop|pause|resume|enable|disable)\b.{0,40}\b(proactive|check[- ]?ins?|pokes?|outreach|reaching out)\b/i.test(t) ||
    /\bproactive\b.{0,24}\b(off|on|pause|stop|resume)\b/i.test(t) ||
    /\b(turn everything off|pause for today|kill switch)\b/i.test(t) ||
    /\b(stop|don't) texting me first\b/i.test(t) ||
    /\bdon't (text|message|ping) me (first|proactively)\b/i.test(t)
  )
}

function parseQuietHours(text: string): string | null {
  const m = foldQuotes(text).match(
    /quiet hours?\s*(?:from\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  )
  if (!m) return null
  const clock = (h: string, min: string | undefined, ap?: string) => {
    let hour = Number(h)
    const minute = Number(min || '0')
    const mer = (ap || '').toLowerCase()
    if (mer.startsWith('p') && hour < 12) hour += 12
    if (mer.startsWith('a') && hour === 12) hour = 0
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }
  return `${clock(m[1] || '22', m[2], m[3])}-${clock(m[4] || '8', m[5], m[6])}`
}

function prettyQuietHours(raw: string): string {
  const fmt = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    const hour = h || 0
    const mer = hour >= 12 ? 'pm' : 'am'
    const h12 = hour % 12 || 12
    return m ? `${h12}:${String(m).padStart(2, '0')}${mer}` : `${h12}${mer}`
  }
  const parts = raw.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/)
  if (!parts) return raw
  return `${fmt(parts[1] || '')} to ${fmt(parts[2] || '')}`
}

async function handleProactiveControl(input: {
  phone: string
  persona: AgentId
  userText: string
}): Promise<string | null> {
  if (!looksLikeProactiveControl(input.userText)) return null
  const t = foldQuotes(input.userText)
  const quiet = parseQuietHours(t)
  const pauseToday = /\bpause for today\b/i.test(t)
  const off =
    (/\b(stop|turn(?: everything)? off|disable|kill switch)\b/i.test(t) ||
      /\b(stop|don't) texting me first\b/i.test(t) ||
      /\bdon't (text|message|ping) me (first|proactively)\b/i.test(t)) &&
    !/\bresume\b/i.test(t) &&
    !pauseToday
  const resume = /\b(resume|turn(?: it| them| proactive)? (back )?on|enable)\b/i.test(t)
  const pause = /\bpause\b/i.test(t) && !resume && !off

  const patch: { proactive?: string; quietHours?: string; pauseToday?: boolean; pausedUntil?: string | null } = {}
  if (quiet) patch.quietHours = quiet
  if (off) patch.proactive = 'off'
  else if (pauseToday) patch.pauseToday = true
  else if (pause) {
    patch.proactive = 'paused'
    patch.pausedUntil = null
  } else if (resume) {
    patch.proactive = 'on'
    patch.pausedUntil = null
  }

  if (!patch.proactive && !patch.quietHours && !patch.pauseToday) return null

  const ok = await setProactiveMode(input.phone, input.persona, patch)
  if (!ok) return "I couldn't change that right now. Try again in a sec?"
  if (off) return "Got it. I won't text first anymore. Say resume proactive if you want me back."
  if (pauseToday) return "Paused for today. I'll start again tomorrow."
  if (pause) return 'Paused. Say resume proactive when you want check ins again.'
  if (quiet && !resume) return `Quiet hours are ${prettyQuietHours(quiet)}. I won't text first inside that window.`
  return "I'll text first again when something is actually useful. Quiet hours stay in place."
}

/** Handle "remind me..." / "my reminders" / "cancel reminder" in one turn. */
async function handleReminderMessage(input: {
  phone: string
  persona: string
  userText: string
  timezone: string
}): Promise<string | null> {
  const intent = await parseReminderIntent(input.userText, input.timezone)
  if (intent.action === 'set') {
    const utc = localTimeToUtc(intent.localTime, input.timezone)
    const text = looksLikeDigestIntent(intent.text)
      ? `${DIGEST_MARKER}${intent.text}`
      : intent.text
    const ok = await createReminder({
      phone: input.phone,
      persona: input.persona,
      text,
      scheduledAt: utc,
      recurrence: intent.recurrence,
      timezone: input.timezone,
    })
    if (!ok) return "I couldn't save that reminder right now. Try again in a sec?"
    const when = intent.recurrence === 'once' ? '' : ` ${intent.recurrence}`
    return `Got it. I'll remind you${when} at ${intent.localTime.slice(0, 16).replace('T', ' ')} (${input.timezone}): "${intent.text}".`
  }
  if (intent.action === 'list') {
    const items = await listReminders(input.phone, input.persona)
    const pending = items.filter((r) => r.status === 'pending' && !/^\[(judge|poke)\]/i.test(r.text))
    if (!pending.length) return "You don't have any reminders lined up right now."
    const lines = pending.map((r) => {
      const when = formatLocalAtSafe(r.scheduledAt, input.timezone)
      const rep = r.recurrence !== 'once' ? ` (${r.recurrence})` : ''
      const label = r.text.replace(/^\[(judge|poke|digest)\]/i, '').trim()
      return `${when}${rep}: ${label}`
    })
    return `Your reminders:\n${lines.join('\n')}`
  }
  if (intent.action === 'cancel') {
    return "Tell me which reminder to remove (paste the time or text) and I'll kill it."
  }
  return null
}

function formatLocalAtSafe(utc: string, timezone: string): string {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    return dtf.format(new Date(utc))
  } catch {
    return new Date(utc).toLocaleString()
  }
}

export async function runHireTurn(input: {
  agentId: AgentId
  dataDir: string
  senderId: string
  userText: string
  /** Optional note appended to context, e.g. that an image was auto-logged. */
  inboundNote?: string
}): Promise<{
  reply: string
  bubbles: string[]
  source: 'gmi' | 'local'
  authoritative: string[]
  card: MiniAppCard | null
}> {
  const agent = getAgent(input.agentId)
  const mem = loadMemory(input.dataDir, input.senderId)
  const history = mem.history
  const live = await fetchLiveProfile(input.senderId, agent.id)
  const spokenTz = timezoneFromText(input.userText)
  if (spokenTz && live.hired) {
    void persistLiveFacts(input.senderId, agent.id, [{ key: 'timezone', value: spokenTz }])
  }
  const timezone = pickUserTimezone({
    message: input.userText,
    userTz: live.timezone,
    contextTz: live.context?.timezone,
    memoryTz: live.memories.find((m) => m.key === 'timezone')?.value,
  })
  // First iMessage to this hire: introduce once. Website name/setup does not
  // count. lastInboundAt survives bot restarts when the local thread file is empty.
  const textedBefore = !!(history.length || mem.summary.trim() || live.lastInboundAt)
  const isFirst = !textedBefore
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')?.content
  const recentUserTexts = history.filter((m) => m.role === 'user').slice(-6).map((m) => m.content)
  const briefIntent =
    looksLikeDigestIntent(input.userText) || looksLikeAffirmedBrief(input.userText, lastAssistant)
  const eveningBriefIntent = looksLikeEveningBriefIntent(input.userText)

  if (live.hired) {
    void touchInbound(input.senderId, agent.id)
  }

  if (live.hired && looksLikeProactiveControl(input.userText)) {
    const handled = await handleProactiveControl({
      phone: input.senderId,
      persona: agent.id,
      userText: input.userText,
    })
    if (handled) {
      const reply = stripDashes(handled)
      appendThread(input.dataDir, input.senderId, [
        { role: 'user', content: input.userText },
        { role: 'assistant', content: reply },
      ])
      return { reply, bubbles: splitBubbles(reply), source: 'gmi', authoritative: [], card: null }
    }
  }

  if (live.hired && looksLikeReminder(input.userText)) {
    const handled = await handleReminderMessage({
      phone: input.senderId,
      persona: agent.id,
      userText: input.userText,
      timezone,
    })
    if (handled) {
      const reply = stripDashes(handled)
      appendThread(input.dataDir, input.senderId, [
        { role: 'user', content: input.userText },
        { role: 'assistant', content: reply },
      ])
      return { reply, bubbles: splitBubbles(reply), source: 'gmi', authoritative: [], card: null }
    }
  }

  const miniApp = live.hired
    ? briefIntent
      ? { kind: 'digest' as const }
      : eveningBriefIntent
        ? { kind: 'pick_night' as const }
        : detectMiniAppRequest(input.userText, agent.id, recentUserTexts)
    : null

  if (miniApp && (miniApp.kind === 'apps' || miniApp.kind === 'menu')) {
    appendThread(input.dataDir, input.senderId, [{ role: 'user', content: input.userText }])
    const card = await mintMiniAppCard(input.senderId, agent.id, miniApp.kind, miniApp.query)
    return { reply: '', bubbles: [], source: 'local', authoritative: [], card }
  }

  let digestText: string | null = null
  if (live.found && live.hired && briefIntent) {
    const digest = await buildDigestBriefing(input.senderId, agent.id)
    digestText = digest?.text?.trim() || null
  }

  const writeIntent = wantsOperatorWrite(input.userText)
  const hardStop = classifyHardStop(input.userText)
  const humanLimit = classifyHumanLimit(input.userText)
  const skipFreeLookup = !!(
    miniApp &&
    miniApp.kind !== 'pick_night' &&
    miniApp.kind !== 'digest' &&
    !writeIntent
  )

  let toolResults: string[] = []
  if (live.found && live.hired && !digestText && !skipFreeLookup) {
    if (agent.id !== 'friend' && (briefIntent || wantsLiveData(input.userText))) {
      toolResults = await fetchLiveTools(
        input.senderId,
        agent.id,
        briefIntent ? BRIEF_TOOL_QUERY : input.userText,
      )
      if (
        !toolResults.length &&
        /\b(check|look up|find|search|book|pull|inbox|mail|calendar|slack|linear|notion|drive|maps|dinner|place)\b/i.test(
          input.userText,
        )
      ) {
        const picked = await pickLiveTool(input.userText, live.connected, agent.id)
        if (picked && TOOL_HINT[picked]) {
          toolResults = await fetchLiveTools(input.senderId, agent.id, TOOL_HINT[picked])
        }
      }
    }
    if (!toolResults.length && maybeToolIntent(input.userText)) {
      const intent = await classifyFreeLookup(input.userText)
      if (intent && intent.tool !== 'none' && (intent.query || input.userText)) {
        toolResults = await fetchLiveTools(
          input.senderId,
          agent.id,
          intent.query || input.userText,
          intent.tool,
        )
      }
    }
  }

  const extras: string[] = []
  let confirmKind: MiniAppKind | null = null
  let confirmQuery: Record<string, string> | undefined
  let friendLife: Awaited<ReturnType<typeof fetchJudgmentState>> = null
  if (!live.found) {
    extras.push(
      'This sender is not linked to a HireAlpha account yet. If they ask about email, calendar, or personal setup, tell them to sign in at hirealpha.chat/app with the same phone they are texting from.',
    )
  } else if (!live.hired) {
    extras.push(
      `They have a HireAlpha account (${live.email || 'signed in'}) but have not hired this person yet. Point them to hirealpha.chat/app to hire ${agent.name}.`,
    )
  } else {
    extras.push(formatNowForAgent(timezone))
    if (isFirst) {
      extras.push(
        `This is their first iMessage to you${live.name ? `. Their name is ${live.name}` : ''}. Introduce yourself once, briefly, in the same text as the answer. No taglines. No second bubble.`,
      )
    } else {
      extras.push(
        `This is not their first text. You already know them${live.name ? ` (${live.name})` : ''}. Never introduce yourself. Never say good to meet you. Continue the thread.`,
      )
    }
    if (briefIntent) {
      extras.push(
        isFirst
          ? 'They asked for a brief/debrief on their first text. One short hello in the same message, then the full day wrap. Do not ask "debrief what."'
          : 'They asked for a brief/debrief. That always means the full day wrap: what happened today, mail that matters, leftover tonight, tomorrow, reminders, and open loops / the backup list. Give it in one text. Do not ask "debrief what." Do not introduce yourself.',
      )
    }
    const ctx = formatHireContext(live.context)
    if (ctx) extras.push(ctx)
    if (live.location && (live.location.label_text || live.location.label)) {
      extras.push(
        `They gave a safe ${live.location.label} label: "${live.location.label_text || live.location.label}". When replying about nearby places, say you searched near that, not that we know their exact coordinates.`,
      )
    }
    const remembered = formatHireMemories(live.memories)
    if (remembered) extras.push(remembered)
    if (agent.id === 'friend') {
      friendLife = await fetchJudgmentState(input.senderId, agent.id, 'turn')
      if (friendLife) extras.push(formatLifeStateBlock(friendLife))
      extras.push(TOOL_LOOP_INSTRUCTIONS)
      if (looksLikeLifeTap(input.userText)) {
        extras.push(
          'They answered a tap from a previous text (eat, skip, later, done, send, in, out). Honor that using the life state numbers. If they said eat, tell them the protein number and one food. If they said skip, accept it. Do not claim you logged, booked, or sent anything unless a tool result says so.',
        )
      }
    }
  }
  if (hardStop) extras.push(hardStopInstruction(hardStop))
  if (humanLimit) {
    const taughtTaste = [...(live.memories || []).map((m) => m.key), ...Object.keys(live.context || {})].some((k) =>
      /style|taste|aesthetic|fashion|vibe|look/i.test(k),
    )
    extras.push(humanLimitInstruction(humanLimit, taughtTaste))
  }

  let miniRun: { text?: string; paste?: string } | null = null
  if (miniApp && LIVE_MINI.has(miniApp.kind)) {
    miniRun = await fetchMiniRun(input.senderId, agent.id, miniApp.kind)
    if (miniRun?.text || miniRun?.paste) {
      extras.push(
        `Live mini-app result for "${miniApp.kind}" (ground truth, put this in the text, do not invent a different answer):\n${miniRun.paste || miniRun.text}`,
      )
    }
  }
  if (miniApp?.kind === 'nutrition' && looksLikeNutritionLog(input.userText)) {
    const nutrition = await autoLogNutrition(input.senderId, agent.id, input.userText)
    if (nutrition?.logged) {
      extras.push(
        nutrition.estimated === false
          ? `Nutrition was automatically logged as ${nutrition.guess || input.userText}. The macro estimate is pending (the estimator did not answer), so do not state calorie/protein numbers — say the meal is logged and the macros will fill in.`
          : `Nutrition was automatically logged as ${nutrition.guess || input.userText} (${nutrition.calories || 0} calories, ${nutrition.protein || 0}g protein, ${nutrition.carbs || 0}g carbs, ${nutrition.fat || 0}g fat). Confirm the log briefly in the reply; do not ask them to log it again.`,
      )
    } else if (nutrition?.error) {
      extras.push('Nutrition auto-log failed. Do not claim the meal was logged; offer the Nutrition card instead.')
    }
  }
  if (miniApp?.kind === 'workout_log' && looksLikeWorkoutLog(input.userText)) {
    const workout = await autoLogWorkout(input.senderId, agent.id, input.userText)
    if (workout?.logged) {
      extras.push(
        `Workout was automatically logged as ${workout.exercise} ${workout.sets}x${workout.reps}${workout.weight ? ` @ ${workout.weight}` : ''}. Confirm briefly; do not ask them to log it again.`,
      )
    } else {
      extras.push('Could not parse a workout from that text. Do not claim it was logged. Tell them to open the Workout log card and enter exercise, sets, reps, and weight.')
    }
  }
  if (miniApp?.kind === 'sleep_tracker') {
    const sleep = await autoLogSleep(input.senderId, agent.id, input.userText)
    if (sleep?.logged) {
      extras.push(
        `Sleep was automatically logged for last night, ${sleep.bedtime} to ${sleep.wake}. Confirm briefly; do not ask them to log it again.`,
      )
    } else {
      extras.push('No bedtime/wake times found in the text. Do not claim sleep was logged. Tell them to open the Sleep card and tap Log last night.')
    }
  }
  if (miniApp?.kind === 'gratitude_journal' && looksLikeGratitudeLog(input.userText)) {
    const gratitude = await autoLogGratitude(input.senderId, agent.id, input.userText)
    if (gratitude?.logged) {
      extras.push(
        `Gratitude was automatically logged: "${gratitude.text}". Confirm briefly; do not ask them to log it again.`,
      )
    } else {
      extras.push('Could not parse what they are grateful for. Do not claim it was logged. Tell them to open the Gratitude card.')
    }
  }
  if (looksLikeMoodReply(input.userText)) {
    const mood = await autoLogMood(input.senderId, agent.id, input.userText)
    if (mood?.logged) {
      extras.push(
        `Mood was automatically logged as ${mood.emoji} (energy ${mood.energy}/5). Confirm briefly in the reply; do not ask them to log it again or pick another emoji.`,
      )
    } else if (mood?.error) {
      extras.push('Mood auto-log did not recognize a mood emoji. Do not claim the mood was logged; if they clearly named a mood, tell them it is saved to the Mood tracker.')
    }
  }
  const proactiveTopic = miniApp?.kind === 'habit_streak'
    ? 'habit_streak'
    : looksLikeHabitDone(input.userText)
      ? (await fetchLastProactiveTopic(input.senderId, agent.id)).topic
      : null
  if (
    !looksLikeMoodReply(input.userText) &&
    looksLikeHabitDone(input.userText) &&
    (proactiveTopic === 'habit_risk' || proactiveTopic === 'habit_streak' || /workout|done today|did .*\?/i.test(lastAssistant || ''))
  ) {
    const habit = await autoLogHabit(input.senderId, agent.id, input.userText)
    if (habit?.logged) {
      extras.push(
        `${habit.habit} was marked done today. Confirm briefly; do not ask them to log it again.`,
      )
    } else {
      extras.push('Habit auto-log could not find a matching habit. Do not claim it was logged.')
    }
  }
  if (
    miniApp?.kind === 'spending_snapshot' &&
    looksLikeBudgetSet(input.userText) &&
    hardStop !== 'money'
  ) {
    const set = await autoSetBudget(input.senderId, agent.id, input.userText)
    if (set?.logged) {
      extras.push(
        `Weekly budget was set to $${Math.round(Number(set.weeklyBudget) || 0)}. Confirm briefly; do not mention the old value.`,
      )
    } else {
      extras.push('Could not read a budget amount. Do not claim the budget changed. Ask for the amount, or point them to the Spending card.')
    }
  }
  if (looksLikePrefsSet(input.userText) && !looksLikeBudgetSet(input.userText) && hardStop !== 'money') {
    const pref = await autoSetPrefs(input.senderId, agent.id, input.userText)
    if (pref?.changed) {
      const bits: string[] = []
      if (pref.workoutDays?.length) bits.push(`workout days: ${prefDaysLabel(pref.workoutDays)}`)
      if (pref.workoutPlace) bits.push(`workout place: ${pref.workoutPlace}`)
      if (pref.workoutMoveCount) bits.push(`moves per day: ${pref.workoutMoveCount}`)
      if (pref.sleepBedtime) bits.push(`bedtime: ${pref.sleepBedtime}`)
      if (pref.sleepWake) bits.push(`wake: ${pref.sleepWake}`)
      extras.push(
        `Settings were updated — ${bits.join('; ')}. Confirm in one line and do not list anything else that did not change.`,
      )
    } else {
      extras.push('Could not read a setting to change. Do not claim anything was updated. Ask what they want changed, or point them to Settings.')
    }
  }
  if (
    miniApp?.kind === 'spending_snapshot' &&
    !looksLikeBudgetSet(input.userText) &&
    looksLikeSpendLog(input.userText) &&
    hardStop !== 'money'
  ) {
    const spend = await autoLogSpend(input.senderId, agent.id, input.userText)
    if (spend?.logged) {
      extras.push(
        `Spend was automatically logged: $${spend.amount} (${spend.category}${spend.description ? `, ${spend.description}` : ''}). Confirm briefly; do not ask them to log it again.`,
      )
    } else if (spend && 'overCap' in spend && spend.overCap) {
      extras.push(
        `That spend would break the weekly cap ($${Math.round(Number(spend.weekTotal) || 0)} of $${Math.round(Number(spend.weeklyBudget) || 0)}, plus $${spend.amount}). Do not log it. Tell them to tap the Spending card if they still want it on the book. Never claim it was logged.`,
      )
    } else {
      extras.push('Could not parse an amount to log. Do not claim spend was logged. Tell them to open the Spending card.')
    }
  }
  if (
    miniApp?.kind === 'networking_crm' &&
    !looksLikeFollowUp(input.userText) &&
    !looksLikeMailWrite(input.userText) &&
    !looksLikePrep(input.userText)
  ) {
    const network = await autoLogNetwork(input.senderId, agent.id, input.userText)
    if (network?.logged) {
      extras.push(
        `${network.name ? `"${network.name}"` : 'A contact'} was automatically added to the Networking CRM${network.place ? ` (met at "${network.place}")` : ''}. Confirm briefly; do not ask them to add it again.`,
      )
    } else if (network && !network.logged) {
      extras.push('Contact was not saved. Do not claim it was logged. The Networking card is attached; they can add the person there.')
    }
    // If network is null, no name was parseable; card still delivered, say nothing about logging.
  }
  if (miniApp?.kind === 'learning_queue') {
    const learning = await autoSaveLearning(input.senderId, agent.id, input.userText, recentUserTexts)
    if (learning?.logged) {
      extras.push(
        `Saved to Learning Queue${learning.title ? `: "${learning.title}"` : ''}. Confirm briefly; do not ask them to save it again.`,
      )
    } else {
      extras.push('Could not auto-save to Learning Queue. Do not claim it was saved. The Learning Queue card is attached; they can add it from there.')
    }
  }
  if (
    live.found &&
    live.hired &&
    agent.id === 'friend' &&
    !digestText
  ) {
    const people: PersonHit[] = [
      ...(friendLife?.peoplePhones || []),
      ...(friendLife?.peopleDue || []),
    ]
    const smsAsk = /\b(?:text|sms)\b/i.test(input.userText)
    let prepLoaded = false
    const weekAsk =
      looksLikeWeekRun(input.userText) ||
      (miniApp?.kind === 'weekly_review' && !/\b(?:open|show|pull up|bring back)\b/i.test(input.userText))
    if (!hardStop && humanLimit !== 'grief' && weekAsk) {
      const week = await fetchWeekBundle(input.senderId, agent.id)
      if (week?.text) {
        prepLoaded = true
        extras.push(
          `Week bundle (ground truth, already saved. Stitch into one iMessage. Do not ask them to fill the weekly review card):\n${week.text}`,
        )
      } else {
        extras.push('Week lookup came back empty. Do not invent a review. Offer to try again.')
      }
      if (week?.spendOver) {
        confirmKind = 'spending_snapshot'
        extras.push(
          'They are over the weekly spend cap. Money needs a tap. Tell them to open Spending. Do not log more spend. Never move money.',
        )
      } else if (week?.ping?.email) {
        const draft = pingMail({ name: week.ping.name, email: week.ping.email, phone: week.ping.phone })
        if (draft) {
          const proposed = await saveFriendDraft(input.senderId, agent.id, draft)
          if (proposed.ok && proposed.id) {
            confirmKind = 'approve_send'
            confirmQuery = { draft: proposed.id }
            extras.push(
              `A follow up for ${week.ping.name} is public, so a Send card is attached. Tell them to tap Send. Never claim you sent.`,
            )
          }
        }
      } else if (week?.ping?.phone) {
        confirmKind = 'networking_crm'
        extras.push(
          `They are due to ping ${week.ping.name}. Number on file: ${week.ping.phone}. That is public, so tell them to tap Text. Never claim you sent a text.`,
        )
      }
    } else if (!hardStop && humanLimit !== 'grief' && looksLikePrep(input.userText)) {
      const prep = await fetchPrepBundle(
        input.senderId,
        agent.id,
        prepTarget(input.userText) || input.userText,
      )
      if (prep?.text) {
        prepLoaded = true
        extras.push(
          `Prep bundle (ground truth, stitch this into one iMessage. Do not ask them to pull the calendar, notes, or thread separately):\n${prep.text}\n\nWrite who, when, last note, what the thread said, and what to say. If a Send card is attached, tell them to tap Send. Never claim you sent.`,
        )
      } else {
        extras.push(
          'Prep lookup came back empty. Say you could not find that person, event, notes, or thread. Do not invent. Offer to try a different name.',
        )
      }
      if (prep?.draft?.kind === 'reply' && prep.draft.messageId) {
        const proposed = await saveFriendDraft(input.senderId, agent.id, {
          type: 'reply',
          id: prep.draft.messageId,
          body: prep.draft.body,
        })
        if (proposed.ok && proposed.id) {
          confirmKind = 'approve_send'
          confirmQuery = { draft: proposed.id }
          extras.push(
            'A confirm card is attached for the mail. Tell them to tap Send. Never claim you sent.',
          )
        }
      } else if (prep?.draft?.kind === 'mail' && prep.draft.to) {
        const proposed = await saveFriendDraft(input.senderId, agent.id, {
          type: 'mail',
          to: prep.draft.to,
          subject: prep.draft.subject,
          body: prep.draft.body,
        })
        if (proposed.ok && proposed.id) {
          confirmKind = 'approve_send'
          confirmQuery = { draft: proposed.id }
          extras.push(
            'A confirm card is attached for the mail. Tell them to tap Send. Never claim you sent.',
          )
        }
      }
    } else if (!hardStop && humanLimit !== 'grief' && humanLimit !== 'negotiation' && writeIntent) {
      let draft: DraftCall | null = null
      const person = matchPerson(input.userText, people)
      if (looksLikeFollowUp(input.userText) && !looksLikeEventWrite(input.userText)) {
        if (smsAsk && person?.phone) {
          confirmKind = 'networking_crm'
          extras.push(
            `They want to text ${person.name}. Number on file: ${person.phone}. Tell them to tap Text on the People card. Never claim you sent a text.`,
          )
        } else if (person?.email) {
          draft = looksLikeMailWrite(input.userText)
            ? (await extractFriendWrite(input.userText, people, friendLife?.mail || [], timezone)) || pingMail(person)
            : pingMail(person)
        } else if (person?.phone) {
          confirmKind = 'networking_crm'
          extras.push(
            `They want to follow up with ${person.name}. Number on file: ${person.phone}. Tell them to tap Text on the People card. Never claim you sent a text.`,
          )
        }
      }
      if (!draft && !confirmKind && (looksLikeMailWrite(input.userText) || looksLikeEventWrite(input.userText))) {
        draft = await extractFriendWrite(input.userText, people, friendLife?.mail || [], timezone)
        if (draft?.type === 'mail' && !draft.to.includes('@') && person?.email) {
          draft = { ...draft, to: person.email }
        }
      }
      if (draft) {
        const proposed = await saveFriendDraft(input.senderId, agent.id, draft)
        if (proposed.ok && proposed.id) {
          confirmKind = draft.type === 'event' ? 'pick_slot' : 'approve_send'
          confirmQuery = { draft: proposed.id }
          extras.push(
            `A confirm card is attached for ${draft.type === 'event' ? 'the calendar event' : 'the mail'}. Tell them to tap ${draft.type === 'event' ? 'Book' : 'Send'}. Never claim you sent or booked.`,
          )
        } else {
          extras.push(
            `Could not save that draft. ${proposed.error || 'Try again.'} Do not claim you sent or booked.`,
          )
        }
      }
    }

    let roundsUsed = toolResults.length ? 1 : 0
    let already = [
      (friendLife?.calendar || []).join('; '),
      (friendLife?.mail || []).join('; '),
      toolResults.join('\n'),
    ]
      .filter(Boolean)
      .join('\n')
    if (!skipFreeLookup && !prepLoaded && !hardStop && humanLimit !== 'grief') {
      for (; roundsUsed < 3; roundsUsed++) {
        const next = await planNextTool(input.userText, already)
        if (!next) break
        const got = await fetchLiveTools(input.senderId, agent.id, next.query, next.tool)
        const block = got.length
          ? got.join('\n\n')
          : `Lookup for ${next.tool} came back empty. Do not invent.`
        toolResults.push(block)
        already = `${already}\n${block}`
      }
    }
  }

  if (digestText) {
    extras.push(
      `Live day wrap (ground truth, use this, do not invent):\n${digestText}\n\nWrite the debrief from this. Cover today, mail, tonight leftover, tomorrow, reminders, and open loops. One message. No intro.`,
    )
  } else if (toolResults.length) {
    const calLive = toolResults.some((t) => t.startsWith('Upcoming events') || t.startsWith('No events'))
    extras.push(
      `Live tool results (ground truth, use these, do not invent):\n${toolResults.join('\n\n')}\n\n${
        calLive
          ? 'Calendar clocks in this block are already local. Repeat the printed time and the zone letters (PST, PDT, EST, EDT, BST, GMT, UTC). Never convert to a different zone. Never call a Meet or a phone a dinner, lunch, or drinks unless the title says that.\n\n'
          : ''
      }When email results are present: give a short overview of the batch (how many, themes), then call out the top 2-3 that matter most with a one-line reason each. Do not fixate on a single email.`,
    )
  } else if (live.hired && live.connected.length) {
    extras.push(
      `These tools are connected for this person: ${live.connected.join(', ')}. If they just asked about one of them, say it is connected and that the lookup came back empty, or offer to try again. Never say the tool is not connected.`,
    )
  }
  if (miniApp) {
    extras.push(
      miniApp.kind === 'apps' || miniApp.kind === 'menu'
        ? 'An apps card is being delivered. Tell them to tap the one they want. Keep your text short. The card is the list.'
        : miniApp.kind === 'digest'
          ? 'A day-wrap card is being delivered. Put the full brief/debrief in your text. The card is extra. Do not keep the text short. Do not ask what they meant.'
          : LIVE_MINI.has(miniApp.kind)
            ? `A mini-app card for "${miniApp.kind}" is also being delivered. Put the live mini-app result in your text. The card is extra.`
            : `A mini-app card for "${miniApp.kind}" is being delivered with your reply. Keep your text short and offer the card in one line.`,
    )
  }
  if (input.inboundNote) {
    extras.push(input.inboundNote)
  }

  const memoryBlock = buildMemoryBlock(mem, live.memories || [])

  const system = [
    buildSystemPrompt(agent, live.connected),
    skillsPromptBlock(agent.id, live.connected),
    memoryBlock,
    extras.join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n\n')

  let reply: string
  let source: 'gmi' | 'local' = 'gmi'

  // Strip stale "not connected" assistant replies from history so the model
  // can't pattern-match on them when tool results ARE present this turn.
  const STALE_CONNECTED = /\b(not connected|isn't connected|not linked to a hirealpha|can't see your|sign in at hirealpha)\b/i
  const cleanHistory = history.filter((m) => {
    if (m.role !== 'assistant') return true
    if (STALE_CONNECTED.test(m.content)) return false
    if (isTheaterCopy(m.content)) return false
    return true
  })

  try {
    const firstHint = isFirst
      ? '\nThis is their first iMessage to you. Introduce yourself once, briefly, in character, then answer in the same text. No taglines. Do not send a second message.'
      : '\nThis is not their first text. Do not introduce yourself. Do not say good to meet you. Answer in one message.'
    const maxTokens =
      toolResults.length || digestText || briefIntent || agent.id === 'friend'
        ? Math.max(agent.maxTokens, 800)
        : Math.max(agent.maxTokens, 320)
    const baseMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: system + firstHint },
      ...cleanHistory,
      { role: 'user', content: input.userText },
    ]
    if (live.hired && agent.id === 'friend') {
      const loopMessages = [...baseMessages]
      reply = await gmiChat({
        temperature: agent.temperature,
        maxTokens,
        messages: loopMessages,
      })
      const leftoverTool = parseToolCall(reply)
      const leftoverDraft = parseDraftCall(reply)
      if (leftoverTool && !digestText) {
        const got = await fetchLiveTools(input.senderId, agent.id, leftoverTool.query, leftoverTool.tool)
        const block = got.length
          ? got.join('\n\n')
          : `Lookup for ${leftoverTool.tool} came back empty. Do not invent.`
        loopMessages.push(
          { role: 'assistant', content: stripToolDirectives(reply) || 'Looking that up.' },
          { role: 'user', content: `Tool result for ${leftoverTool.tool} (ground truth, use this):\n${block}` },
        )
        reply = await gmiChat({
          temperature: agent.temperature,
          maxTokens,
          messages: loopMessages,
        })
      } else if (leftoverDraft && !confirmKind && !hardStop && humanLimit !== 'grief' && humanLimit !== 'negotiation') {
        const proposed = await saveFriendDraft(input.senderId, agent.id, leftoverDraft)
        if (proposed.ok && proposed.id) {
          confirmKind = leftoverDraft.type === 'event' ? 'pick_slot' : 'approve_send'
          confirmQuery = { draft: proposed.id }
          loopMessages.push(
            { role: 'assistant', content: stripToolDirectives(reply) || 'Draft is ready.' },
            {
              role: 'user',
              content:
                'Draft is saved. A confirm card is attached. Tell them to tap Send or Book. Never claim you sent or booked.',
            },
          )
          reply = await gmiChat({
            temperature: agent.temperature,
            maxTokens: Math.max(agent.maxTokens, 320),
            messages: loopMessages,
          })
        }
      }
      reply = stripToolDirectives(reply)
    } else {
      reply = await gmiChat({
        temperature: agent.temperature,
        maxTokens,
        messages: baseMessages,
      })
    }
  } catch (err) {
    console.warn(`[${agent.id}] GMI fallback:`, err)
    if (miniApp) {
      reply = miniAppFallbackText(miniApp.kind)
    } else if (isFirst) {
      const intros: Record<AgentId, string> = {
        friend:
          "Hey, I'm Alpha. I'm here to help.",
        coworker:
          "Alpha (Coworker) here. Send me the raw notes and I'll tighten them.",
        cofounder:
          "Alpha(CoFounder). What's the real decision this week?",
      }
      reply = `${intros[agent.id]}\n\n${runAgentLocally(agent, input.userText)}`
    } else {
      reply = runAgentLocally(agent, input.userText)
    }
    source = 'local'
  }

  const authoritative = live.found ? Object.keys(live.context) : []
  let finalReply = stripReasoning(reply, !isFirst)
  const askedWhat =
    /\bdebrief what\b|\bbrief what\b|\bwhich (?:one|debrief|brief)\b|\bgive me the thread\b|\bgood to meet you\b/i.test(
      foldQuotes(finalReply || reply),
    )
  if (briefIntent && digestText && (!finalReply || askedWhat)) finalReply = digestText
  if (!finalReply) {
    finalReply = miniApp ? miniAppFallbackText(miniApp.kind) : 'I hit a snag. Try that again?'
  }
  finalReply = sanitizeOutbound(finalReply)
  if (isBannedTagline(finalReply) || !finalReply.trim()) {
    finalReply =
      briefIntent && digestText
        ? sanitizeOutbound(digestText) || 'On it. Give me one more beat.'
        : miniApp
          ? miniAppFallbackText(miniApp.kind)
          : 'On it. Give me one more beat.'
  }
  console.log(`[turn] raw reply (${reply.length} chars): ${reply.slice(0, 300)}`)
  console.log(`[turn] final reply (${finalReply.length} chars): ${finalReply.slice(0, 300)}`)
  console.log(`[turn] bubbles: ${splitBubbles(finalReply).length}`)

  appendThread(input.dataDir, input.senderId, [
    { role: 'user', content: input.userText },
    { role: 'assistant', content: finalReply },
  ])
  const cardKind = confirmKind || miniApp?.kind || null
  const cardQuery = confirmQuery || miniApp?.query
  /* One card per intent, not one per turn: back-to-back taps used to stack the
   * same card twice in the thread. Suppress the same kind for 90 seconds, and
   * never attach one when the reply text already links the mini app. */
  const card = cardKind && !/\/app\/mini\//.test(finalReply) && allowMiniAppCard(input.senderId, agent.id, cardKind)
    ? await mintMiniAppCard(input.senderId, agent.id, cardKind, cardQuery)
    : null

  return { reply: finalReply, bubbles: splitBubbles(finalReply), source, authoritative, card }
}

/** Throttle identical cards: same person, same persona, same kind, inside 90s. */
const lastMiniAppCard = new Map<string, number>()
function allowMiniAppCard(senderId: string, persona: string, kind: string): boolean {
  const key = `${senderId}|${persona}|${kind}`
  const now = Date.now()
  if (now - (lastMiniAppCard.get(key) || 0) < 90_000) return false
  lastMiniAppCard.set(key, now)
  return true
}

async function planNextTool(
  userText: string,
  already: string,
): Promise<{ tool: 'maps' | 'web' | 'gmail' | 'calendar' | 'drive'; query: string } | null> {
  try {
    const raw = await gmiChat({
      temperature: 0,
      maxTokens: 80,
      messages: [
        {
          role: 'system',
          content:
            'Decide if another live lookup is needed before answering this iMessage. JSON only, exactly one of {"tool":"maps","query":"..."}, {"tool":"web","query":"..."}, {"tool":"gmail","query":"..."}, {"tool":"calendar","query":"..."}, {"tool":"drive","query":"..."}, {"tool":"none"}. Use none if calendar, mail, or people are already in context, they are only chatting, or they only asked to send mail, book, or follow up.',
        },
        {
          role: 'user',
          content: `Message: ${userText}\nAlready have:\n${already.slice(0, 1200) || '(none)'}`,
        },
      ],
    })
    return parsePlannerTool(raw)
  } catch {
    return null
  }
}

async function extractFriendWrite(
  userText: string,
  people: PersonHit[],
  mail: string[],
  timezone: string,
): Promise<DraftCall | null> {
  try {
    const roster = people
      .map((p) => `${p.name} phone=${p.phone || ''} email=${p.email || ''}`)
      .join('; ')
    const raw = await gmiChat({
      temperature: 0,
      maxTokens: 220,
      messages: [
        {
          role: 'system',
          content: `Extract a mail send, mail reply, or calendar event from one iMessage. JSON only: {"action":"mail","to":"","subject":"","body":""} or {"action":"reply","id":"","body":""} or {"action":"event","title":"","start":"","end":""} or {"action":"none"}. Use the People roster for email addresses. Use judged mail id= for replies. Event times are in ${timezone}. start can be ISO like 2026-08-21T15:00 or spoken tomorrow 3pm. No markdown.`,
        },
        {
          role: 'user',
          content: `People: ${roster || 'none'}\nMail: ${mail.join('; ') || 'none'}\nMessage: ${userText}`,
        },
      ],
    })
    const hit = parseExtractedWrite(raw)
    if (hit?.type === 'mail' && !hit.to.includes('@')) {
      const p = matchPerson(`email ${hit.to}`, people) || matchPerson(userText, people)
      if (p?.email) return { ...hit, to: p.email }
    }
    return hit
  } catch {
    return null
  }
}

async function saveFriendDraft(
  phone: string,
  persona: AgentId,
  draft: DraftCall,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (draft.type === 'mail') {
    return proposeLiveDraft(phone, persona, {
      kind: 'mail',
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
    })
  }
  if (draft.type === 'reply') {
    return proposeLiveDraft(phone, persona, {
      kind: 'reply',
      messageId: draft.id,
      body: draft.body,
    })
  }
  return proposeLiveDraft(phone, persona, {
    kind: 'event',
    title: draft.title,
    start: draft.start,
    end: draft.end,
  })
}

/**
 * Post-reply memory maintenance. Call AFTER bubbles are sent so it never
 * delays the user's reply. Self-contained: prunes expired facts, extracts
 * durable facts (supplementing, never overriding, dashboard ground truth),
 * and rolls the summary when history grows past MAX_RAW. Any failure is
 * logged and swallowed so it can't break the message loop.
 */
export async function runMemoryMaintenance(input: {
  dataDir: string
  senderId: string
  agentId: AgentId
  authoritative: string[]
  userText: string
  reply: string
}): Promise<void> {
  try {
    pruneExpiredFacts(input.dataDir, input.senderId)

    const mem = loadMemory(input.dataDir, input.senderId)
    const facts = await extractFacts({
      userText: input.userText,
      reply: input.reply,
      existing: mem.facts,
      authoritative: input.authoritative,
    })
    if (facts.length) {
      upsertFacts(input.dataDir, input.senderId, facts)
      await persistLiveFacts(
        input.senderId,
        input.agentId,
        facts.map((f) => ({ key: f.key, value: f.value })),
      )
    }

    const after = loadMemory(input.dataDir, input.senderId)
    if (after.history.length >= MAX_RAW) {
      const keepLast = 8
      const toFold = after.history.slice(0, after.history.length - keepLast)
      const summary = await summarizeOld({ history: toFold, priorSummary: after.summary })
      setSummary(input.dataDir, input.senderId, summary)
      trimHistory(input.dataDir, input.senderId, keepLast)
    }
  } catch (err) {
    console.warn(`[${input.agentId}] memory maintenance failed:`, err)
  }
}

export { getAgent }
