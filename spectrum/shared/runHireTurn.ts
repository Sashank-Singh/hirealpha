import type { DeliveryHooks } from './progressiveDelivery'
import {
  getAgent,
  buildSystemPrompt,
  type AgentId,
} from '../../src/agents'
import { runAgentLocally } from '../../src/agents/runtime'
import { runConversationalFriend } from './conversationalFriend'
import { isAffirmativeApprovalIntent, isNegativeCancellationIntent } from './conversationalApproval'
import { skillsPromptBlock, SKILLS } from './skills'
import { gmiChat } from './gmi'
import { appendThread, loadMemory, setPendingSpend, upsertFacts, pruneExpiredFacts, setSummary, trimHistory, MAX_RAW, type ThreadMemory } from './memory'
import { extractFacts, summarizeOld } from './memoryMaintain'
import { liveFactsToInput, localFactsToInput, mergeMemoryFacts, selectMemoryFacts } from './memoryBlock'
import { autoIterateWorkshop, autoLogGratitude, autoLogHabit, autoLogMood, autoLogNutrition, autoLogSleep, autoLogSpend, autoLogWorkout, autoLogNetwork, autoLogDecision, autoLogLoops, autoLogPipeline, autoLogStandup, autoRunWorkshop, autoWorkshopKeep, autoWorkshopToss, autoSaveLearning, autoSetBudget, autoSetPrefs, executeSpendApproval, fetchLiveProfile, fetchLiveTools, fetchMiniRun, fetchPrepBundle, fetchWeekBundle, formatHireContext, persistLiveFacts, proposeLiveDraft,
  proposePurchase, proposeBrowserTask, touchInbound, importChatExport, addMeeting, fetchRenewalRadar, setTravel } from './liveContext'
import { captureFromChat } from './cofounderPro'
import { coworkerCaptureFromChat } from './coworkerPro'
import { onboardingStage, runOnboardingTurn, suggestConnector } from './onboarding'
import {
  looksLikeReminder,
  parseReminderIntent,
  createReminder,
  listReminders,
  localTimeToUtc,
  formatLocalNow,
} from './reminders'
import { setProactiveMode, fetchLastProactiveTopic, fetchJudgmentState } from './judgment'
import { keepHonestPlan, parseBrainDump, keepTravelPlan, scanSubscriptions } from './smartFeatures'
import { formatLifeStateBlock } from './lifeState'
import {
  DIGEST_MARKER,
  detectMiniAppRequest,
  looksLikeAffirmedBrief,
  looksLikeDigestIntent,
  looksLikeEveningBriefIntent,
  isMinimalCardKind,
  mintMiniAppCard,
  onboardingCard,
  miniAppFallbackText,
  buildDigestBriefing,
  type MiniAppCard,
  type MiniAppKind,
} from './miniApps'
import { foldQuotes, isBannedTagline, dropBannedTaglines } from './outboundFilter'
import { formatNowForAgent, pickUserTimezone, timezoneFromText } from '../../deploy/timezones'
import { dispatch as dispatchSmart, type DispatchContext, matchedCapability } from './dispatcher'
import { fetchContacts, fetchSpending, peekDelegateDraft, retainDelegateDraft, sendMailDirect, takeDelegateDraft } from './liveContext'
import {
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
  pingMail,
  wantsOperatorWrite,
  runToolConversation,
  LIVE_TOOLS,
  type DraftCall,
  type PersonHit,
} from './toolLoop'

export { isBannedTagline } from './outboundFilter'

/** Time-sensitive asks the model must never answer from memory. */
export function wantsFreshInfo(text: string): boolean {
  return /\b(news|latest|price|prices|how much (?:is|does|do)|score|who won|release date|say this week|this week|today|yesterday|tonight|right now)\b/i.test(
    text,
  )
}

/** A degenerate model completion (reasoning loop) repeats one phrase many
 * times. Delivering it is worse than an error message: catch it before send. */
export function isDegenerateRepetition(text: string): boolean {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ').trim()
  if (clean.length < 400) return false
  const words = clean.split(/\s+/)
  for (let n = 4; n <= 10; n++) {
    for (let i = 0; i + n * 3 <= words.length; i += n) {
      const gram = words.slice(i, i + n).join(' ').toLowerCase()
      let count = 0
      let from = 0
      while ((from = clean.toLowerCase().indexOf(gram, from)) !== -1) {
        count++
        from += gram.length
        if (count >= 3) return true
      }
    }
  }
  return false
}

export function splitBubbles(text: string): string[] {
  const cleaned = sanitizeOutbound(text.replace(/\r/g, ''))
  if (!cleaned) return []
  // Blank-line-separated paragraphs land as their own bubbles, so a multi-part
  // reply reads like a real back-and-forth instead of one long block.
  const blocks = cleaned
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean)
  const parts = blocks.length > 1 ? blocks : [cleaned]
  // A repeated identical bubble reads as a glitch (and a delivery retry can
  // double the whole text) — say it once.
  return parts.filter((b, i) => i === 0 || b !== parts[i - 1])
}

/* No default card: a text-first hire replies in text. If the turn minted no
 * specific organizer/confirm card, it delivers none — a menu is never the
 * default. (Kept as an async null so the call sites stay unchanged.) */
export async function defaultReplyCard(_phone: string, _persona: AgentId): Promise<MiniAppCard | null> {
  return null
}

/** After a slash capability's reply is built, perform the real write the feature
 * stood for: brain dumps → loops + decisions + notes-reminders, "keep me honest"
 * → an actual reminder, and recall → a mail pull when the user has mail connected.
 * Returns the extra copy to append to the reply ("" when nothing to say). */
async function applySmartEffects(
  name: string,
  ctx: DispatchContext,
  input: { senderId: string },
  agent: { id: AgentId },
  connectedMail: boolean,
): Promise<string> {
  const extra: string[] = []
  try {
    if (name === 'dump' || name === 'brain_dump') {
      const items = parseBrainDump(ctx.text)
      const saved: string[] = []
      if (items.loops.length) {
        const r = await autoLogLoops(input.senderId, agent.id, items.loops)
        if (r?.logged && r.count) saved.push(`${r.count} loop${r.count === 1 ? '' : 's'}`)
        else if (r?.error) extra.push(`Loop save failed: ${r.error}.`)
      }
      let decisions = 0
      for (const d of items.decisions) {
        if ((await autoLogDecision(input.senderId, agent.id, d))?.logged) decisions++
      }
      if (decisions) saved.push(`${decisions} decision${decisions === 1 ? '' : 's'}`)
      // Notes that name a clock time become real reminders.
      let reminders = 0
      for (const n of items.notes) {
        const plan = keepHonestPlan(n)
        if (!plan) continue
        const hh = String(plan.hour).padStart(2, '0')
        const mm = String(plan.minute).padStart(2, '0')
        const today = formatLocalNow(ctx.timezone).slice(0, 10)
        const ok = await createReminder({
          phone: input.senderId,
          persona: agent.id,
          text: n,
          scheduledAt: localTimeToUtc(`${today}T${hh}:${mm}:00`, ctx.timezone),
          recurrence: 'once',
          timezone: ctx.timezone,
        })
        if (ok) reminders++
      }
      if (reminders) saved.push(`${reminders} reminder${reminders === 1 ? '' : 's'}`)
      if (saved.length) extra.push(`Saved ${saved.join(', ')} — tracked for real.`)
      else if (!extra.length) extra.push('Nothing new to save from that.')
    }

    if (name === 'honest') {
      const plan = keepHonestPlan(ctx.text)
      if (plan) {
        const hh = String(plan.hour).padStart(2, '0')
        const mm = String(plan.minute).padStart(2, '0')
        const today = formatLocalNow(ctx.timezone).slice(0, 10)
        const ok = await createReminder({
          phone: input.senderId,
          persona: agent.id,
          text: `Keep me honest: ${plan.what}`,
          scheduledAt: localTimeToUtc(`${today}T${hh}:${mm}:00`, ctx.timezone),
          recurrence: 'daily',
          timezone: ctx.timezone,
        })
        extra.push(
          ok
            ? `I will text you at ${hh}:${mm} each day. Text me it happened and I will skip that one.`
            : 'Could not set the reminder — check your connection and try again.',
        )
      }
    }

    if (name === 'recall') {
      const keyword = ctx.text
        .replace(/^\/recall\b/i, '')
        .replace(/\b(?:what|who|when|where|why|how|did|does|is|are|was|have i|do you know|me|my|the|a|an|about|regarding|that|this|promis\w*|loop|owe\w*|decid\w*|said|mail|email|talk\w*|note\w*|asked|agreed)\b/gi, ' ')
        .trim()
      if (connectedMail && keyword) {
        const prep = await fetchPrepBundle(input.senderId, agent.id, keyword)
        if (prep?.text) extra.push(`From your mail:\n${prep.text.slice(0, 900).trim()}`)
      }
    }

    if (name === 'import') {
      const res = await importChatExport(input.senderId, agent.id, ctx.text)
      if (res?.ok && res.people) {
        extra.push(`Filed ${res.lines} lines from ${res.people} person${res.people === 1 ? '' : 's'} as context for prep and recall.`)
      } else {
        extra.push(`Could not import that chat${res?.error ? ` — ${res.error}` : ''}.`)
      }
    }

    if (name === 'debrief') {
      const title = ctx.text
        .replace(/^\/(?:debrief|dr)\b/i, '')
        .replace(/\b(?:debrief|how did (?:the |that )?(?:meeting|call|interview|sync)|wrap (?:the )?(?:meeting|call|day)|after (?:the )?(?:meeting|call))\b/gi, ' ')
        .replace(/\b(?:meeting|call|1-?1|sync|interview|with|about)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      // The user's answers to these prompts get persisted on later turns; open a
      // real meeting now so the debrief has somewhere to land.
      const ok = await addMeeting(input.senderId, agent.id, title || 'Debrief')
      if (ok?.ok) extra.push('Logged the meeting — answer the prompts and I will file each commitment for real.')
      else extra.push('Could not open a meeting record right now.')
    }

    if (name === 'bills') {
      if (connectedMail) {
        const radar = await fetchRenewalRadar(input.senderId, agent.id, ctx.text)
        const hits = radar?.hits || []
        if (hits.length) {
          const lines = hits.slice(0, 6).map((h) => {
            const amt = h.amount != null ? ` $${Math.round(h.amount * 100) / 100}/${h.period}` : ` (${h.period})`
            return `- ${h.merchant || 'Subscription'}${amt}${h.date ? ` · renews ${h.date}` : ''}`
          })
          extra.push(`Renewal radar:\n${lines.join('\n')}`)
        } else if (radar?.error) {
          extra.push(`Renewal scan unavailable${radar.error ? ` — ${radar.error}` : ''}.`)
        }
      } else if (ctx.context?.subscriptions) {
        const radar = scanSubscriptions(ctx.context.subscriptions)
        if (radar.length) {
          extra.push(`Renewal radar:\n${radar.map((h) => `- ${h.merchant} $${h.amount}/${h.period}`).join('\n')}`)
        }
      }
    }

    if (name === 'travel') {
      const plan = keepTravelPlan(ctx.text)
      if (plan) {
        const set = await setTravel(input.senderId, agent.id, plan.dest, plan.tz)
        if (set?.ok) {
          extra.push(`Travel flagged for ${plan.dest}${plan.tz ? ` (${plan.tz})` : ''} — briefs and pings will shift to local time while you are away.`)
          if (plan.tz) extra.push('Say "build my travel checklist" and I will put together a pack list.')
        } else {
          extra.push(`Could not flag travel${set?.error ? ` — ${set.error}` : ''}.`)
        }
      }
    }
  } catch (err) {
    console.warn('[turn] smart side-effect failed', err)
    extra.push('I could not reach your stores right now — the answer above still stands.')
  }
  return extra.length ? '\n' + extra.join('\n') : ''
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
    .map((p) => returning
      ? p
        // "Hey! I'm Alpha, your assistant. I can help with that. Let me..."
        // — a full self-intro on a returning thread reads like amnesia, so
        // cut the intro sentence(s) and keep the actual answer.
        .replace(/^(?:hey!\s*)?i'?m alpha,? (?:your|their|the) (?:assistant|personal assistant|friend|hired friend)[^.!?]*[.!?]\s*/i, '')
        .replace(/^(?:(?:hey|hi|hello)[,!]?\s*)?(?:i'?m|i am|this is)\s+Alpha(?:\s*\((?:Coworker|CoFounder)\))?(?:\s+here)?(?:\s*,\s*your\s+[^.!?]+)?[.!?]\s*/i, '')
        .trim()
      : p)
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
  // Stage acks ("I'm checking...") were never sent as bubbles but the model
  // sometimes echoes them as its opener anyway. Cut leading ack noise.
  const noAck = text.replace(
    /^[ \t]*(?:(?:i['’]?m|i am) (?:checking|looking|pulling|searching|digging)[^.!?\n]*(?:for this|for you|now|it up)?[.!]?\s*\n?)+/i,
    '',
  )
  // iMessage renders no markdown: **bold** / *italic* / `code` / ## headers
  // arrive as literal characters. Strip the markup, keep the words.
  const stripped = noAck
    .replace(/\*\*(\S[^*]*?)\*\*/g, '$1')
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$|[.,!?])/g, '$1$2')
    .replace(/(^|\s)(#{1,3})\s+/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
  const cleaned = stripDashes(dropBannedTaglines(stripped))
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
  if (/^\s*(?:remember|keep in mind|note that|never forget)\b/i.test(text)) return false
  return /\b(near(?: by)?|around|where\b|recommend|suggest|show me|find|search|look(?:ing|ing for| up| it up)|dinner|lunch|breakfast|eat|food|restaurant|cafe|bar|coffee|spot|place|tonight|weekend|date night|hangout|movie|weather|news|latest|price|how much|delivery|takeout|reservation|book|maps?|directions|inbox|unread|mail|e-?mail|texts?|messages?|whatsapp|telegram|slack|notion|linear|github|calendar|schedule|agenda)\b/i.test(
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
  return /grateful(?:\s+for)?\s*[:-]?\s*\S+/i.test(text)
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

/** Mood answers only. "good morning" / "good night" / "ok thanks" are greetings
 * and acknowledgements, not mood reports — matching them silently logged a mood
 * with an invented energy score. A trailing greeting word disqualifies the
 * match, and the whole message must be the mood (nothing but filler after). */
const MOOD_GREETING = /\b(?:morning|night|evening|afternoon|day|to see you|to meet you|thanks|thank you|luck|job)\b/i

export function looksLikeMoodReply(text: string) {
  const t = text.trim()
  if (!t || t.length > 40) return false
  if (/^[😄🙂😐😔😤]+$/u.test(t)) return true
  if (MOOD_GREETING.test(t)) return false
  return /^(?:(?:i'?m|i am)\s+)?(good|fine|okay|ok|great|meh|tired|exhausted|sad|down|rough|bad|angry|stressed|frustrated)(?:\s+(?:out|today|thanks|right now|a bit|bit|tbh))?\s*[.!]*$/i.test(t)
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

/**
 * The facts block plus the rolling summary.
 *
 * Facts are selected by `selectMemoryFacts`: identity facts pinned, everything
 * else newest-first, bounded by a token budget. Callers must not slice the
 * result — the previous implementation took the first twelve entries of an
 * insertion-ordered Map, which kept the oldest facts and dropped every new one.
 */
export function buildMemoryBlock(
  mem: ThreadMemory,
  liveFacts: Array<{ key: string; value: string; durable?: boolean; updatedAt?: string }>,
): string {
  const selected = selectMemoryFacts(mergeMemoryFacts(localFactsToInput(mem.facts), liveFactsToInput(liveFacts)))
  const facts = selected.length ? selected.map((f) => `${f.key}: ${f.value}`).join('\n') : ''
  const summary = mem.summary.trim()
  const parts: string[] = []
  if (facts) parts.push(`## Known facts about this person (never guess past these)\n${facts}`)
  if (summary) parts.push(`## Memory of past conversations\n${summary}`)
  return parts.join('\n\n')
}

/** Handle stop/pause/resume proactive in one turn. */
function looksLikeProactiveControl(text: string): boolean {
  const t = foldQuotes(text)
  return (
    /\b(stop|pause|resume|enable|disable)\b.{0,40}\b(proactive|check[- ]?ins?|pokes?|outreach|reaching out)\b/i.test(t) ||
    /\bproactive\b.{0,24}\b(off|on|pause|stop|resume)\b/i.test(t) ||
    /\b(turn everything off|pause for today|kill switch)\b/i.test(t) ||
    /\b(stop|don't) texting me first\b/i.test(t) ||
    /\bdon't (text|message|ping) me (first|proactively)\b/i.test(t)
  )
}

async function handleProactiveControl(input: {
  phone: string
  persona: AgentId
  userText: string
}): Promise<string | null> {
  if (!looksLikeProactiveControl(input.userText)) return null
  const t = foldQuotes(input.userText)
  const pauseToday = /\bpause for today\b/i.test(t)
  const off =
    (/\b(stop|turn(?: everything)? off|disable|kill switch)\b/i.test(t) ||
      /\b(stop|don't) texting me first\b/i.test(t) ||
      /\bdon't (text|message|ping) me (first|proactively)\b/i.test(t)) &&
    !/\bresume\b/i.test(t) &&
    !pauseToday
  const resume = /\b(resume|turn(?: it| them| proactive)? (back )?on|enable)\b/i.test(t)
  const pause = /\bpause\b/i.test(t) && !resume && !off

  const patch: { proactive?: string; pauseToday?: boolean; pausedUntil?: string | null } = {}
  if (off) patch.proactive = 'off'
  else if (pauseToday) patch.pauseToday = true
  else if (pause) {
    patch.proactive = 'paused'
    patch.pausedUntil = null
  } else if (resume) {
    patch.proactive = 'on'
    patch.pausedUntil = null
  }

  if (!patch.proactive && !patch.pauseToday) return null

  const ok = await setProactiveMode(input.phone, input.persona, patch)
  if (!ok) return "I couldn't change that right now. Try again in a sec?"
  if (off) return "Got it. I won't text first anymore. Say resume proactive if you want me back."
  if (pauseToday) return "Paused for today. I'll start again tomorrow."
  if (pause) return 'Paused. Say resume proactive when you want check ins again.'
  return "I'll text first again when something is actually useful."
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
  /** The bot already texted "on it" when this build ask arrived, so the final
   * reply must deliver the result, not more status talk. */
  buildAckSent?: boolean
  delivery?: DeliveryHooks
}): Promise<{
  reply: string
  bubbles: string[]
  source: 'gmi' | 'local'
  authoritative: string[]
  card: MiniAppCard | null
  /** True on the pinned first-text welcome: the bot should share its contact
   * card BEFORE the reply so the Add banner leads the conversation. */
  contactCardFirst?: boolean
}> {
  const agent = getAgent(input.agentId)
  const mem = loadMemory(input.dataDir, input.senderId)
  const history = mem.history

  // Navigation is independent of account/profile availability and prior topics.
  // Do this before any profile, judgment, onboarding, or model work. The card's
  // destination still enforces authentication; a token failure falls back to login.
  const explicitNavigation = /^\s*(?:\/?(?:apps?|menu|home)|(?:show|open|pull up)(?: me)?(?: the| my)? (?:apps?|menu|home))\s*[.!?]?\s*$/i.test(input.userText)
  const navigation = explicitNavigation ? detectMiniAppRequest(input.userText, agent.id) : null
  if (navigation?.kind === 'apps' || navigation?.kind === 'menu') {
    const card = await mintMiniAppCard(input.senderId, agent.id, navigation.kind, navigation.query)
    appendThread(input.dataDir, input.senderId, [
      { role: 'user', content: input.userText },
      { role: 'assistant', content: '[Alpha Apps card]' },
    ])
    return { reply: '', bubbles: [], source: 'local', authoritative: [], card }
  }

  const pendingSpend = mem.pendingSpend
  if (pendingSpend && isNegativeCancellationIntent(input.userText)) {
    setPendingSpend(input.dataDir, input.senderId)
    const reply = `Cancelled the order for ${pendingSpend.item}. Let me know if you want to look for something else!`
    appendThread(input.dataDir, input.senderId, [
      { role: 'user', content: input.userText },
      { role: 'assistant', content: reply },
    ])
    return { reply, bubbles: [reply], source: 'local' as const, authoritative: [], card: null }
  }

  if (pendingSpend && isAffirmativeApprovalIntent(input.userText)) {
    const chargeRes = await executeSpendApproval(input.senderId, pendingSpend.id, 'approve')
    setPendingSpend(input.dataDir, input.senderId)
    if (chargeRes.ok) {
      const amountStr = chargeRes.amount || `$${pendingSpend.amount ? pendingSpend.amount.toFixed(2) : ''}`
      const reply = `Payment received: ${amountStr} for ${pendingSpend.item}. I'm finalizing the merchant checkout now and will text the order confirmation number once the merchant confirms it.`
      appendThread(input.dataDir, input.senderId, [
        { role: 'user', content: input.userText },
        { role: 'assistant', content: reply },
      ])
      return { reply, bubbles: [reply], source: 'local' as const, authoritative: [], card: null }
    } else {
      const reply = `Could not complete the charge: ${chargeRes.error || 'Card charge failed'}. Tap the card below to retry or check Settings.`
      const retryCard = await mintMiniAppCard(input.senderId, agent.id, 'approve_purchase', { id: pendingSpend.id })
      appendThread(input.dataDir, input.senderId, [
        { role: 'user', content: input.userText },
        { role: 'assistant', content: reply },
      ])
      return { reply, bubbles: [reply], source: 'local' as const, authoritative: [], card: retryCard }
    }
  }

  const connection = /^\s*(?:(?:please|can you|could you|help me)\s+)?(?:connect|link|hook up)\s+(?:to\s+)?(?:my\s+|the\s+)?(calendar|google calendar|gmail)\s*[.!?]?\s*$/i.exec(input.userText)
  const savedContact = /^\s*(?:i\s+)?(?:did\s+)?(?:already\s+)?saved?\s+(?:(?:your|the)\s+(?:contact|number)\s*)?(?:already)?\s*[.!]?\s*$/i.test(input.userText)
    && (/\b(?:contact|number)\b/i.test(input.userText) || (history.length === 0 && /\balready\b/i.test(input.userText)))
  if (connection || savedContact) {
    const connector = connection?.[1]?.toLowerCase() === 'gmail' ? 'gmail' : 'calendar'
    const reply = connection
      ? `Open https://hirealpha.chat/app?connect=${connector} and tap Connect next to ${connector === 'gmail' ? 'Gmail' : 'Calendar'}. If asked, sign in with the account you use for Alpha.`
      : 'Got it, you saved my contact. What would you like help with?'
    appendThread(input.dataDir, input.senderId, [
      { role: 'user', content: input.userText },
      { role: 'assistant', content: reply },
    ])
    return { reply, bubbles: [reply], source: 'local', authoritative: [], card: null }
  }
  // Judgment state starts BEFORE the profile fetch and overlaps it — its 18s
  // worst case must never serialize behind profile. A thread with zero local
  // history is a first contact: skip it (no state to judge yet).
  const friendJudgmentP =
    agent.id === 'friend' && input.userText.trim().startsWith('/') && (history.length > 0 || mem.summary.trim().length > 0)
      ? fetchJudgmentState(input.senderId, agent.id, 'turn').catch(() => null)
      : null
  const [live, contacts, spending] = await Promise.all([
    fetchLiveProfile(input.senderId, agent.id, input.userText),
    input.senderId ? fetchContacts(input.senderId) : Promise.resolve([]),
    input.senderId && (agent.id !== 'friend' || input.userText.trim().startsWith('/')) ? fetchSpending(input.senderId) : Promise.resolve({ logs: [], weekly: 0, budget: 0 }),
  ])
  if (live.hired && !input.userText.trim().startsWith('/')) {
    void touchInbound(input.senderId, agent.id)
    // Exact opt-out controls remain available even when the model is down.
    if (/^\s*(?:stop|stop texting me|stop texting me first|pause proactive|resume proactive)\s*[.!]?\s*$/i.test(input.userText)) {
      const resume = /^\s*resume/i.test(input.userText)
      const paused = /^\s*pause/i.test(input.userText)
      const ok = await setProactiveMode(input.senderId, agent.id, { proactive: resume ? 'on' : paused ? 'paused' : 'off', pausedUntil: null })
      const reply = ok ? resume ? "I'll check in when something is useful." : "Got it. I won't text first. Your scheduled reminders are unchanged." : 'I could not change that setting. Please try again.'
      appendThread(input.dataDir, input.senderId, [{ role: 'user', content: input.userText }, { role: 'assistant', content: reply }])
      return { reply, bubbles: [reply], source: 'local', authoritative: [], card: null }
    }
    return runConversationalFriend({ ...input, agentId: agent.id, live, memory: mem, contacts })
  }
  if (live.unavailable && wantsLiveData(input.userText)) {
    const reply = 'I could not load your connected account data right now. Please try again in a moment. You do not need to reconnect anything based on this error.'
    appendThread(input.dataDir, input.senderId, [
      { role: 'user', content: input.userText },
      { role: 'assistant', content: reply },
    ])
    return { reply, bubbles: [reply], source: 'local', authoritative: [], card: null }
  }
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

  // A first text that is just a greeting ("Hey, Alpha!", "hi", "yo") gets the
  // pinned welcome verbatim — fast, deterministic, always on copy. Anything
  // with a real question still goes to the model.
  const bareGreeting =
    isFirst && /^(?:hey|hi|hello|yo|hola|sup|what'?s up|howdy)(?:[ ,]+alpha)?[!.?\s]*$/i.test(input.userText.trim())
  // Full name is captured at signup now; the greeting stays first-name warm.
  const greetingName = (live.name || '').trim().split(/\s+/)[0] || 'there'
  const WELCOME = `Hey ${greetingName}, I'm Alpha, your hired friend. I keep the day sane, save the stuff you'd lose, and check in when you need a real person. One card should show up here in a sec to pick how you want to use me.`

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

  // Build asks are a stand-alone capability: someone who just saved Alpha's
  // number and never finished the hire flow can still ask for a build, and the
  // workshop deploys it to their account. Gating the artifact kind on
  // live.hired is how build asks fell through to chat and came back as raw
  // code dumps ("my app builder isn't connected").
  const detected = detectMiniAppRequest(input.userText, agent.id, recentUserTexts)
  const miniApp = live.hired
    ? briefIntent
      ? { kind: 'digest' as const }
      : eveningBriefIntent
        ? { kind: 'pick_night' as const }
        : detected
    : detected?.kind === 'artifact'
      ? detected
      : null

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

/* ---- Dispatcher: slash commands, manifest routing, Tier 4 delegate ----
   * One entry point for every capability. Slash wins, then the manifest, then
   * the never-a-shrug delegate fallback for task-shaped asks. */
  /* "send it" — fires the delegate draft retained from the previous turn. */
  if (live.hired && /^\s*send (?:it|that|the draft)\b/i.test(input.userText)) {
    const draft = peekDelegateDraft(input.senderId, agent.id)
    if (draft) {
      takeDelegateDraft(input.senderId, agent.id)
      const sent = await sendMailDirect(input.senderId, draft.to, draft.subject, draft.body)
      if (sent.ok) {
        const reply = `Sent to ${draft.toName}.`
        appendThread(input.dataDir, input.senderId, [
          { role: 'user', content: input.userText },
          { role: 'assistant', content: reply },
        ])
        return { reply, bubbles: [reply], source: 'local', authoritative: [], card: null }
      }
      retainDelegateDraft(input.senderId, agent.id, draft)
      const fail = `Could not send — ${sent.error || 'unknown error'}. The draft is still here; say send it to retry.`
      appendThread(input.dataDir, input.senderId, [
        { role: 'user', content: input.userText },
        { role: 'assistant', content: fail },
      ])
      return { reply: fail, bubbles: [fail], source: 'local', authoritative: [], card: null }
    }
    // No retained draft: "send it" must never reach the model — with nothing in
    // the delegate slot it improvised a random send target from thread noise.
    const nodraft = "Nothing's queued to send right now. Want me to draft something?"
    appendThread(input.dataDir, input.senderId, [
      { role: 'user', content: input.userText },
      { role: 'assistant', content: nodraft },
    ])
    return { reply: nodraft, bubbles: [nodraft], source: 'local', authoritative: [], card: null }
  }

  if (live.hired && input.userText.trim().startsWith('/')) {
    const smartCtx: DispatchContext = {
      text: input.userText,
      timezone,
      memories: (live.memories || []).map((x) => x.value).filter(Boolean),
      context: live.context || {},
      contacts,
      userName: live.name || null,
      spending,
      retainDraft: (d) => retainDelegateDraft(input.senderId, agent.id, d),
    }
    let handled = dispatchSmart(smartCtx)
    if (handled) {
      const hit = matchedCapability(smartCtx)
      if (hit) {
        const connectedMail = Array.isArray(live.connected) && live.connected.some((c) => /mail|gmail|google/i.test(String(c)))
        const extra = await applySmartEffects(hit.name, smartCtx, { senderId: input.senderId }, agent, connectedMail)
        if (extra) handled = handled + extra
      }
      appendThread(input.dataDir, input.senderId, [
        { role: 'user', content: input.userText },
        { role: 'assistant', content: handled },
      ])
      // Slash replies are command output: one message, never split.
      return { reply: handled, bubbles: [handled], source: 'local', authoritative: [], card: null }
    }
    // Unknown slash word: strip it so the normal pipeline routes the rest —
    // every intent (/workout, /brief, /prep...) gets a slash alias free.
    input.userText = input.userText.replace(/^\s*\//, '').trim()
  }

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
    if (agent.id !== 'friend' && !toolResults.length && maybeToolIntent(input.userText)) {
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
  if (live.unavailable) {
    extras.push('The account lookup is temporarily unavailable. Do not claim this person has no account, has not hired you, or has disconnected tools. Answer general questions normally; be honest that personal data could not be loaded.')
  } else if (!live.found) {
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
        `This is their first iMessage to you${live.name ? `. Their name is ${live.name}` : ''}. Greet them like a real person would, introduce yourself in one line (you are ${agent.imsgName}, their hired ${agent.name}), say in ONE short line what you can do for them (keep it to the highest-value thing, no feature list), and tell them a card is coming in this thread to pick how they want to use you. Keep the whole text short, like a real first text. No taglines. No second bubble.`,
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
    if (live.pro) {
      extras.push('They are a paying subscriber (trial or active). Full access, no rationing. Never mention billing, plans, or upgrades in chat.')
    } else {
      extras.push('They are on the free tier. Never mention billing, plans, trials, or upgrades in chat. Serve them fully within free limits.')
    }
    if (live.location && (live.location.label_text || live.location.label)) {
      extras.push(
        `They gave a safe ${live.location.label} label: "${live.location.label_text || live.location.label}". When replying about nearby places, say you searched near that, not that we know their exact coordinates.`,
      )
    } else {
      // No location on file: never dead-end a "near me" ask with a demand for
      // their city. Use the ZIP/landmark in their message if present; only ask
      // when truly missing, and offer the one-tap fix (set Home in the app).
      extras.push(
        'They have no saved location. If their message names a city, neighborhood, ZIP, or landmark, search near that — do NOT ask them to repeat it. Only if there is truly no location anywhere in the ask, ask once for a city or ZIP and mention they can save Home at hirealpha.chat/app for next time. Never say you cannot get their location.',
      )
    }
    if (agent.id === 'friend') {
      friendLife = friendJudgmentP ? await friendJudgmentP : null
      if (friendLife) extras.push(formatLifeStateBlock(friendLife))
      if (looksLikeLifeTap(input.userText)) {
        extras.push(
          'They answered a tap from a previous text (eat, skip, later, done, send, in, out). Honor that using the life state numbers. If they said eat, tell them the protein number and one food. If they said skip, accept it. Do not claim you logged, booked, or sent anything unless a tool result says so.',
        )
      }
      /* In-conversation reframes: a friend venting in chat is not asking for a
       * tool, a weekly review, or a decision log. Detectors push one short,
       * warm instruction each. The model writes ONE short text, no dashes or
       * markdown, never a list. High-precision guards keep unrelated chat from
       * matching. */
      const userReframe = String(input.userText || '').trim()
      const reframeTaskGuard =
        /^\s*(?:prep|brief|debrief|digest|recap|review|build|make|create|write|draft|send|email|book|schedule|plan|show|pull|open|log|track)\b/i.test(
          userReframe,
        )
      const reframeMiniGuard =
        !miniApp ||
        (miniApp.kind === 'apps' && /^\s*(?:apps?|store)\b/i.test(userReframe)) ||
        (miniApp.kind === 'menu' && /^\s*(?:menu|home|onboarding)\b/i.test(userReframe))
      if (
        live.hired &&
        agent.id === 'friend' &&
        !isFirst &&
        !briefIntent &&
        !digestText &&
        !writeIntent &&
        !hardStop &&
        humanLimit !== 'grief' &&
        !reframeTaskGuard &&
        reframeMiniGuard &&
        userReframe.length <= 240
      ) {
        const spiral =
          /\b(?:can'?t decide|keep going back and forth|go back and forth|what if i (?:pick|choose|make the wrong)|stuck between|can'?t pick)\b/i.test(
            userReframe,
          ) && !/^\s*(?:should i (?:pick|choose)|what should i (?:pick|choose|do))\s*$/i.test(userReframe)
        const spiralGuard =
          /\b(?:which (?:restaurant|place|spot|movie|dinner|option)|where should (?:we|i)|what should we|pick (?:a|the) (?:restaurant|place|spot|movie)|for (?:dinner|lunch|tonight))\b/i.test(
            userReframe,
          )
        const spiralInstruction =
          'They are stuck in a decision spiral. Do not pick for them. Ask "what would you tell your best friend if they were stuck on this?", then reflect their own answer back so they hear it. One short text, no dashes, no markdown.'
        if (spiral && !spiralGuard) extras.push(spiralInstruction)

        const foodGuilt =
          /\b(?:i was so bad|ruined my diet|shouldn'?t have eaten|cheat(?:ed)? (?:on )?my diet|i overate|i binged)\b/i.test(
            userReframe,
          ) && !/^\s*(?:log|track)\b/i.test(userReframe)
        const foodGuiltInstruction =
          'They are guilt-tripping over food. Interrupt the self-criticism warmly: "that was a meal, not a crime." Reframe to the next choice. No macro lecture, no meal plan.'
        if (foodGuilt) extras.push(foodGuiltInstruction)

        const lonely =
          /\b(?:i'?m (?:so |really |feeling )?lonely|i feel alone|no one to talk to|you'?re the only one (?:i|who) (?:talk|text)|i wish i had someone)\b/i.test(
            userReframe,
          )
        const lonelyInstruction =
          'They feel lonely. Acknowledge it genuinely, then point them to a real person they already know. If a specific person is in the People list or the dashboard context (a name they mention, a friend, a sibling, a colleague), name that person and suggest texting or calling them. Otherwise say "someone you have been meaning to call". Do not pitch yourself as the fix, but do not be cold either. One short text, no dashes, no markdown.'
        if (lonely) extras.push(lonelyInstruction)

        const hardWeek =
          /\b(?:last week|this week) was (?:brutal|awful|hell|rough|the worst|so hard|terrible)\b/i.test(
            userReframe,
          ) && /\b(?:week|monday)\b/i.test(userReframe)
        const hardWeekInstruction =
          'They just told you last week was rough. Reply warmly and simply: "last week was rough. this week does not have to prove anything." Do not add a productivity checklist. One short text, no dashes, no markdown.'
        if (hardWeek) extras.push(hardWeekInstruction)

        const finished =
          /\b(?:finally did it|finally done|got it done|submitted it|finished it|sent it|did the thing)\b/i.test(
            userReframe,
          ) && !/^\s*(?:log|track|send|did you (?:get|finish))\b/i.test(userReframe)
        const finishedInstruction =
          'They finished something they were dreading. Name the win simply, then ask "how do you feel?". Do not pile the next task on. One short text, no dashes, no markdown.'
        if (finished) extras.push(finishedInstruction)
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
      extras.push('Nutrition auto-log failed. Do not claim the meal was logged; in one line ask what they ate and log it from their reply text.')
    }
  }
  if (miniApp?.kind === 'workout_log' && looksLikeWorkoutLog(input.userText)) {
    const workout = await autoLogWorkout(input.senderId, agent.id, input.userText)
    if (workout?.logged) {
      extras.push(
        `Workout was automatically logged as ${workout.exercise} ${workout.sets}x${workout.reps}${workout.weight ? ` @ ${workout.weight}` : ''}. Confirm briefly; do not ask them to log it again.`,
      )
    } else {
      extras.push('Could not parse a workout from that text. Do not claim it was logged. In one line ask for the missing piece (exercise, sets, reps, weight) and log it from their reply text.')
    }
  }
  if (miniApp?.kind === 'sleep_tracker') {
    const sleep = await autoLogSleep(input.senderId, agent.id, input.userText)
    if (sleep?.logged) {
      extras.push(
        `Sleep was automatically logged for last night, ${sleep.bedtime} to ${sleep.wake}. Confirm briefly; do not ask them to log it again.`,
      )
    } else {
      extras.push('No bedtime/wake times found in the text. Do not claim sleep was logged. In one line ask for bedtime and wake time and log it from their reply text.')
    }
  }
  if (miniApp?.kind === 'gratitude_journal' && looksLikeGratitudeLog(input.userText)) {
    const gratitude = await autoLogGratitude(input.senderId, agent.id, input.userText)
    if (gratitude?.logged) {
      extras.push(
        `Gratitude was automatically logged: "${gratitude.text}". Confirm briefly; do not ask them to log it again.`,
      )
    } else {
      extras.push('Could not parse what they are grateful for. Do not claim it was logged. In one line ask what they are grateful for and log it from their reply text.')
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
      extras.push('Could not parse an amount to log. Do not claim spend was logged. In one line ask what they spent and on what, then log it from their reply text.')
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
  if (miniApp?.kind === 'decision_ledger') {
    const decision = await autoLogDecision(input.senderId, agent.id, input.userText)
    if (decision?.logged) {
      extras.push(
        `Decision logged: "${decision.decision}". Confirm briefly; do not ask them to log it again.`,
      )
    } else if (decision?.error) {
      extras.push(`Could not parse a decision from that — ${decision.error}. Do not claim it was logged; point them to the Decisions card.`)
    }
  }

  if (miniApp?.kind === 'pipeline_board') {
    const pipe = await autoLogPipeline(input.senderId, agent.id, input.userText)
    if (pipe?.logged) {
      extras.push(
        `Pipeline updated: "${pipe.title}" → ${pipe.stage}. Confirm briefly; do not ask them to move it again.`,
      )
    } else if (pipe?.error) {
      extras.push(`Could not parse a pipeline move — ${pipe.error}. Do not claim it moved; point them to the Pipeline card.`)
    }
  }

  /* CoFounder capture runs on every inbound text, cofounder persona only.
   * Detectors are precision first and only confirmed server creates surface,
   * so the reply never claims a log that did not happen. */
  if (agent.id === 'cofounder' && live.hired) {
    try {
      const captured = await captureFromChat(input.senderId, agent.id, input.userText)
      if (captured.length) {
        extras.push(
          `You just logged ${captured.map((c) => c.summary).join('; ')}. Confirm it in one short line and ask if right. Do not log it again.`,
        )
      }
    } catch (err) {
      console.warn('[runHireTurn] cofounder capture failed', err)
    }
  }

  /* Coworker capture runs on every inbound text, coworker persona only. Same
   * precision first rules; drafts only surface once the server confirms the
   * promise create, and slots and wrap never log anything at all. */
  if (agent.id === 'coworker' && live.hired) {
    try {
      const captured = await coworkerCaptureFromChat(input.senderId, agent.id, input.userText)
      const logged = captured.filter(
        (c): c is Extract<typeof c, { kind: 'promise' | 'decision' | 'person' }> =>
          c.kind === 'promise' || c.kind === 'decision' || c.kind === 'person',
      )
      if (logged.length) {
        extras.push(
          `You just logged ${logged.map((c) => c.summary).join('; ')}. Confirm it in one short line and ask if right. Do not log it again.`,
        )
      }
      for (const c of captured) {
        if (c.kind === 'draft') {
          extras.push(
            `You just queued a draft to ${c.name} in Approve and send. Confirm it in one short line and ask if right. Do not log it again.`,
          )
        } else if (c.kind === 'slots') {
          extras.push(
            'Slot suggestions are in Pick a slot. Point them there in one line; do not invent times in chat.',
          )
        } else if (c.kind === 'wrap') {
          extras.push(
            'The meeting just wrapped. Ask one wrap question: what got decided, the next step, and who owns it. Do not log anything they did not confirm.',
          )
        }
      }
    } catch (err) {
      console.warn('[runHireTurn] coworker capture failed', err)
    }
  }

  /* Onboarding runs in chat right after the intro: while memories are missing
   * name, city, or priority and the thread is still young, the answer gets
   * captured and the next question is injected into the reply. */
  if (
    live.hired &&
    history.length <= 8 &&
    // Onboarding questions must not override an actual request or capture it
    // as a name/priority. Resume only when answering the previous setup prompt.
    (bareGreeting || /what should i call you|what city are you in|what should i help with most/i.test(lastAssistant || '')) &&
    !miniApp && !writeIntent && !wantsLiveData(input.userText) &&
    !/^\s*(?:can you|could you|please|build|make|create|show|open|connect|help|explain)\b/i.test(input.userText) &&
    (agent.id === 'friend' || agent.id === 'cofounder' || agent.id === 'coworker') &&
    onboardingStage([
      ...(live.memories || []),
      // The signup already knows their name (web account) — never re-ask what
      // the DB holds. City/priority still come from chat.
      ...(live.name ? [{ key: 'preferred_name', value: live.name }] : []),
    ]) !== 'done'
  ) {
    try {
      const question = await runOnboardingTurn(
        input.senderId,
        agent.id,
        input.userText,
        [
          ...(live.memories || []),
          ...(live.name ? [{ key: 'preferred_name', value: live.name }] : []),
        ],
      )
      if (question) {
        extras.push(
          `You are mid onboarding. Reply with this question, at most one warm word about their answer added: '${question}'. Do not answer anything else.`,
        )
      }
    } catch (err) {
      console.warn('[runHireTurn] onboarding failed', err)
    }
  }

  /* The workshop path calls the planner model and the sandbox; a throw anywhere
   * in it must cost the build, not the whole turn — the outer catch would turn
   * a failed build into the canned "Got tripped up" reply. */
  if (miniApp?.kind === 'artifact') {
    const ackNote = input.buildAckSent
      ? 'You already texted that you are building it, so do NOT say "working on it", "still on it", or promise any arrival time. Deliver the result or the failure now, in one or two lines.\n\n'
      : ''
    try {
      const built = await autoRunWorkshop(input.senderId, agent.id, input.userText)
      if (built?.logged && built.url) {
        extras.push(
          `${ackNote}A FRESH build was deployed just now — even if something similar existed before, this is a new one; never say it was already built. Title: "${built.title}". Send them this exact link in your reply so they can open it: ${built.url}. Tell them to try it, then say "keep it" (stays forever) or "toss it" (deleted). Unkept builds auto-delete in 7 days. Do not restate the code. Never promise an arrival time.`,
        )
      } else {
        extras.push(
          `${ackNote}The build failed — ${built?.error || 'unknown error'}. Open your reply with the admission that the build did not finish (for example "That didn't finish, sorry"), include the exact error in parentheses so they can see why, then ask what they wanted it to do. Do NOT say "working on it" or "I'll spin that up", and never tell them to build it themselves from a card.`,
        )
      }
    } catch (err) {
      console.warn('[turn] workshop build crashed', err)
      extras.push(
        `${ackNote}The build failed — the builder hit an unexpected error. Open your reply with the admission that the build did not finish, then ask what they wanted it to do. Do NOT say "working on it" or promise a retry time.`,
      )
    }
  }

  /* Iterate: a change request on a build Alpha recently delivered. Only when
   * a /b/ link went out recently, no other intent claimed the message, and
   * the ask is short and change-shaped — "make it 50/10", "add a sound",
   * "dark theme". Long messages and other intents stay normal chat. */
  const recentBuildDelivered = history
    .filter((m) => m.role === 'assistant')
    .slice(-4)
    .some((m) => m.content.includes('/b/'))
  if (
    live.hired &&
    recentBuildDelivered &&
    !miniApp &&
    input.userText.split(/\s+/).length <= 18 &&
    /\b(?:change|update|modify|tweak|iterate|revise|remake|make it|add|remove|rename|swap)\b/i.test(input.userText)
  ) {
    try {
      const updated = await autoIterateWorkshop({
        phone: input.senderId,
        persona: agent.id,
        instruction: input.userText,
      })
      if (updated?.ok && updated.url) {
        extras.push(
          `Updated build deployed — this is a NEW version, the old link still works too. Title: "${updated.title}". Send them this exact link: ${updated.url}. One line confirming the change they asked for.`,
        )
      } else if (updated && updated.error && updated.error !== 'no build on file') {
        extras.push(
          `The update failed — ${updated.error}. In one line, say honestly the change did not go through.`,
        )
      }
      // null or 'no build on file' → not an iteration target; fall through to
      // normal chat silently.
    } catch (err) {
      console.warn('[turn] workshop iterate crashed', err)
    }
  }

  if (looksLikeKeepIt(input.userText)) {
    try {
      const kept = await autoWorkshopKeep(input.senderId, agent.id)
      if (kept?.logged) {
        extras.push('They said keep it: the last built artifact is now saved permanently. Confirm in a few words.')
      } else {
        extras.push('They said keep it but there is no delivered build to keep. Say so plainly.')
      }
    } catch (err) {
      console.warn('[turn] workshop keep crashed', err)
      extras.push('They said keep it but the keep request hit an error. Say so plainly and ask them to try again.')
    }
  }
  if (looksLikeTossIt(input.userText)) {
    try {
      const tossed = await autoWorkshopToss(input.senderId, agent.id)
      if (tossed?.logged) {
        extras.push('They said toss it: the last built artifact was deleted. Confirm in a few words.')
      } else {
        extras.push('They said toss it but there is no delivered build to delete. Say so plainly.')
      }
    } catch (err) {
      console.warn('[turn] workshop toss crashed', err)
      extras.push('They said toss it but the delete hit an error. Say so plainly and ask them to try again.')
    }
  }

  if (miniApp?.kind === 'standup_paste') {
    const standup = await autoLogStandup(input.senderId, agent.id, input.userText)
    if (standup?.logged) {
      extras.push('Standup notes saved for today. Confirm briefly; do not ask them to re-paste.')
    } else if (standup?.error) {
      extras.push(`Could not save standup notes — ${standup.error}. Do not claim they were saved.`)
    }
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
    const weekAsk =
      looksLikeWeekRun(input.userText) ||
      (miniApp?.kind === 'weekly_review' && !/\b(?:open|show|pull up|bring back)\b/i.test(input.userText))
    if (!hardStop && humanLimit !== 'grief' && weekAsk) {
      const week = await fetchWeekBundle(input.senderId, agent.id)
      if (week?.text) {
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
      // SMS still needs the People card. Email and event drafts are decided
      // inside the tool loop, after it has looked up the required context.
      const person = matchPerson(input.userText, people)
      if (smsAsk && person?.phone) {
        confirmKind = 'networking_crm'
        extras.push(`They want to text ${person.name}. Number on file: ${person.phone}. Tell them to tap Text on the People card. Never claim you sent a text.`)
      }
    }
    const roster = [...people, ...contacts]
    if (roster.length) extras.push(`Known contacts (use these details; never invent recipients):\n${JSON.stringify(roster)}`)
  }

  if (digestText) {
    extras.push(
      `Live day wrap (ground truth, use this, do not invent):\n${digestText}\n\nWrite the debrief from this. Cover today, mail, tonight leftover, tomorrow, reminders, and open loops. One message. No intro.`,
    )
  } else if (toolResults.length) {
    const calLive = toolResults.some((t) => t.startsWith('Upcoming events') || t.startsWith('No events'))
    const mapBlock = toolResults.find((t) => t.startsWith('Map results for'))
    const mapHint = mapBlock
      ? ' Compare the actual map results against their request and remembered preferences. Recommend the best supported fit with one reason and one alternate, and include the selected result’s link. Search order is not a quality ranking. Do not invent prices, ratings, opening hours, availability, or quietness.'
      : ''
    extras.push(
      `Live tool results (ground truth, use these, do not invent):\n${toolResults.join('\n\n')}\n\n${
        calLive
          ? 'Calendar clocks in this block are already local. Repeat the printed time and the zone letters (PST, PDT, EST, EDT, BST, GMT, UTC). Never convert to a different zone. Never call a Meet or a phone a dinner, lunch, or drinks unless the title says that.\n\n'
          : ''
      }When email results are present: give a short overview of the batch (how many, themes), then call out the top 2-3 that matter most with a one-line reason each. Do not fixate on a single email.${mapHint}`,
    )
  } else if (live.hired && live.connected.length) {
    extras.push(
      `These tools are connected for this person: ${live.connected.join(', ')}. If they just asked about one of them, say it is connected and that the lookup came back empty, or offer to try again. Never say the tool is not connected.`,
    )
  } else if (live.hired && (live as { degraded?: boolean }).degraded) {
    // A degraded payload means the connector read did not answer in time —
    // that is not the same as "nothing is connected", and saying so is how a
    // fully connected user gets told to go reconnect.
    extras.push(
      'This turn could not verify which tools are connected. Do not claim any tool is or is not connected; if they ask, say the check did not answer and you will try again.',
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

  /* Connector ask in context: when the ask is mail, calendar, brief, or
   * schedule shaped and Google is not connected, hand over the deep link that
   * lands on the connector in settings. */
  const connectorAsk = live.hired ? suggestConnector(input.userText, live.connected || []) : null
  if (connectorAsk) {
    extras.push(
      `Their Google mail and calendar are not connected and this ask wants them. Append this line to your reply: "${connectorAsk.text}" Do not claim you pulled anything.`,
    )
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

  // Pinned welcome: a bare first greeting is answered by the template, not the
  // model — no latency, no drift, exact copy. The onboarding card still rides.
  if (bareGreeting) {
    const onboarding = allowMiniAppCard(input.senderId, agent.id, 'menu')
      ? await onboardingCard(input.senderId, agent.id)
      : null
    appendThread(input.dataDir, input.senderId, [
      { role: 'user', content: input.userText },
      { role: 'assistant', content: WELCOME },
    ])
    return { reply: WELCOME, bubbles: splitBubbles(WELCOME), source: 'local', authoritative: [], card: onboarding, contactCardFirst: true }
  }

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
    // Simple-ask short-circuit: short conversational texts with no tool, write,
    // brief, or card intent go straight to the model. The decision loop adds
    // latency and a second failure surface to the most common messages ("ok
    // cool", "remember: gym is Barezz") and buys nothing there.
    const lastAssistant = cleanHistory.filter((m) => m.role === 'assistant').slice(-1)[0]?.content || ''
    const answeringProposal = Boolean(lastAssistant && /propos|draft|confirm|approve/i.test(lastAssistant))
    const isMemoryDirective = /^\s*(?:remember(?:\s+for\s+good|\s+this)?|note\s+that|keep\s+in\s+mind|never\s+forget|always\s+remember)\b/i.test(input.userText)
    const simpleAsk =
      (isMemoryDirective || input.userText.length <= 120) &&
      !maybeToolIntent(input.userText) &&
      !answeringProposal &&
      !wantsOperatorWrite(input.userText) &&
      !/\b(draft|reply|forward|send)\b/i.test(input.userText) &&
      !briefIntent &&
      !eveningBriefIntent &&
      !miniApp &&
      !hardStop &&
      !humanLimit &&
      !wantsFreshInfo(input.userText)
    if (live.hired && agent.id === 'friend' && !simpleAsk) {
      // Early acknowledgement: Photon rejects SetTyping on this tier, which turned
      // multi-step turns (maps, web, browser tasks) into 60-90s blind waits.
      // An immediate progress bubble lets the user know Alpha is actively on it.
      if (input.delivery?.onProgress) {
        const isHotelOrDining = /\b(?:hotel|hotels|restaurant|restaurants|dinner|lunch|breakfast|cafe|food|eat)\b/i.test(input.userText)
        const ackText = isHotelOrDining
          ? 'On it — checking real listings now.'
          : 'Looking into this now.'
        void input.delivery.onProgress(ackText).catch(() => undefined)
      }
      let purchaseSetupUrl: string | null = null
      let purchaseRequestId: string | null = null
      let browserSessionUrl: string | null = null
      const outcome = await runToolConversation({
        messages: baseMessages,
        delivery: input.delivery,
        chat: (messages, timeoutMs) => gmiChat({ temperature: Math.min(agent.temperature, 0.3), messages, timeoutMs }),
        lookup: (tool, query) => fetchLiveTools(input.senderId, agent.id, query, tool as any),
          propose: (draft) =>
            saveFriendDraft(input.senderId, agent.id, draft).then((r: any) => {
              if (draft.type === 'browser' && r?.ok && r.sessionUrl) {
                browserSessionUrl = r.sessionUrl as string
              }
              if (draft.type === 'purchase' && r.ok) {
              if (r.needsSetup && r.setupUrl) {
                purchaseSetupUrl = r.setupUrl
              } else if (r.requestId || r.id) {
                purchaseRequestId = r.requestId || r.id
                setPendingSpend(input.dataDir, input.senderId, {
                  id: purchaseRequestId!,
                  item: draft.item,
                  amount: draft.amount,
                  url: draft.url,
                  createdAt: Date.now(),
                })
              }
            }
            return r
          }),
        availableTools: LIVE_TOOLS.filter((tool) => tool === 'maps' || tool === 'web' || (live.connected as string[]).includes(tool)),
        canDraft: !hardStop && humanLimit !== 'grief' && humanLimit !== 'negotiation' && !confirmKind,
        existingDraft: confirmQuery?.draft ? { id: confirmQuery.draft, type: 'mail' } : undefined,
      })
      reply = outcome.reply
      if (outcome.draft) {
        if (outcome.draft.type === 'browser') {
          // Auto-launch: the run starts now, scoped to the named site for this
          // one task; the result lands back in this thread via the
          // browser_result loop when the worker finishes.
          reply = browserSessionUrl
            ? `${reply}\nWatch it live: ${browserSessionUrl} (the run started just now; it pauses on its own before payment or any password, and I'll report back when it's done)`.trim()
            : `${reply}\n(I'll start that run and report back here when it's done)`.trim()
        } else if (outcome.draft.type === 'purchase') {
          if (purchaseSetupUrl) {
            reply = `${reply}\nRegister your card or Link wallet here to authorize purchases (one-time setup): ${purchaseSetupUrl}\nOnce registered, reply or text me to complete the order!`.trim()
          } else if (purchaseRequestId) {
            confirmKind = 'approve_purchase'
            confirmQuery = { id: purchaseRequestId }
            reply = `${reply}\n\nTap the card below in iMessages to approve, or text "approve" to buy!`.trim()
          }
        } else {
          confirmKind = outcome.draft.type === 'event' ? 'pick_slot' : 'approve_send'
          confirmQuery = { draft: outcome.draft.id }
        }
      }

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
  if (isDegenerateRepetition(finalReply)) {
    finalReply = 'That one got away from me mid-thought. Say it again?'
  }
  if (isBannedTagline(finalReply) || !finalReply.trim()) {
    finalReply =
      briefIntent && digestText
        ? sanitizeOutbound(digestText) || 'On it. Give me one more beat.'
        : miniApp
          ? miniAppFallbackText(miniApp.kind)
          : 'On it. Give me one more beat.'
  }
  /* Turn-level debugging is opt-in: the raw reply carries user text, so it
   * never goes to production logs by default. */
  if (process.env.HIREALPHA_TURN_DEBUG) {
    console.log(`[turn] raw reply (${reply.length} chars): ${reply.slice(0, 300)}`)
    console.log(`[turn] final reply (${finalReply.length} chars): ${finalReply.slice(0, 300)}`)
    console.log(`[turn] bubbles: ${splitBubbles(finalReply).length}`)
  }

  appendThread(input.dataDir, input.senderId, [
    { role: 'user', content: input.userText },
    { role: 'assistant', content: finalReply },
  ])
  const cardKind = confirmKind || miniApp?.kind || null
  const cardQuery = confirmQuery || miniApp?.query
  /* One card per intent, not one per turn: back-to-back taps used to stack the
   * same card twice in the thread. Only the minimal organizer/confirm kinds
   * mint at all — note-trackers are answered in text, so no card here. Suppress
   * the same kind for 90 seconds, and never attach one when the reply text
   * already links the mini app. */
  let card: MiniAppCard | null = null
  if (cardKind && isMinimalCardKind(cardKind) && !/\/app\/mini\//.test(finalReply) && (confirmQuery?.draft || allowMiniAppCard(input.senderId, agent.id, cardKind))) {
    card = await mintMiniAppCard(input.senderId, agent.id, cardKind, cardQuery)
  }
  /* Very first text to a hire: no specific intent yet, so attach the onboarding
   * home card. It shows what this hire can do and starts the "how do you want
   * to use me" conversation; picks land via /api/setup. Never re-send on later
   * texts — that is what the 90s throttle plus this isFirst gate are for. */
  if (!card && isFirst && allowMiniAppCard(input.senderId, agent.id, 'home')) {
    card = await onboardingCard(input.senderId, agent.id)
  }

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

async function saveFriendDraft(
  phone: string,
  persona: AgentId,
  draft: DraftCall,
): Promise<{ ok: boolean; id?: string; url?: string; error?: string }> {
  if (draft.type === 'purchase') {
    return proposePurchase(phone, persona, { item: draft.item, amount: draft.amount, url: draft.url })
  }
  if (draft.type === 'browser') {
    return proposeBrowserTask(phone, persona, { portal: draft.portal, goal: draft.goal })
  }
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

export function looksLikeKeepIt(text: string) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '')
  return /^(keep( it| this| that| them)?|keep|save it|pin it)$/.test(t)
}

export function looksLikeTossIt(text: string) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '')
  return /^(toss( it| this| that| them)?|toss|delete( it| this| that| the (tracker|page|artifact|thing|tool))?)$/.test(t)
}
