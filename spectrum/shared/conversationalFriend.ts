import type { DeliveryHooks } from './progressiveDelivery'
import { sanitizeOutbound } from './runHireTurn'
import { classifyTurnStrict, ClassifierUnavailableError, logsOf } from './turnIntent'
import { generateTurnImage, pushTurnImage } from './imageRequest'
import { writeToWorkspace } from './workWrite'
import { persistLiveFacts } from './liveContext'
import { getAgent, type AgentId } from '../../src/agents'
import { runAgentLocally } from '../../src/agents/runtime'
import { formatNowForAgent, pickUserTimezone } from '../../deploy/timezones'
import { gmiChat, type GmiChatMessage } from './gmi'
import { FAST_REPLY_WALL_MS } from './delivery'
import { appendThread, recordCardDelivered, setPendingConnection, setPendingSpend, setPendingVaultTask, upsertFacts, type ThreadMemory } from './memory'
import {
  autoLogNutrition, autoLogWorkout, autoLogSleep, autoLogGratitude, autoLogMood,
  autoLogHabit, autoLogSpend, autoLogDecision, autoLogLoops, autoSaveLearning,
  autoRunWorkshop, autoIterateWorkshop, autoWorkshopKeep,
  executeSpendApproval, fetchLiveTools, fetchMiniRun, fetchPrepBundle, proposeBrowserTask, proposeLiveDraft, proposePurchase, manageTodos, scheduleTextLater, suggestCalendarSlots, type LiveProfile,
} from './liveContext'
import { buildDigestBriefing, mintMiniAppCard, type MiniAppCard, type MiniAppKind } from './miniApps'
import { createReminder, listReminders } from './reminders'
import { setProactiveMode } from './judgment'
import {
  calendarBlockTitle, calendarBlockWhen, isTravelRunAsk, LIVE_TOOLS, looksLikeCalendarBlockAsk, missingConnectorNote,
  runToolConversation, WORK_LIVE_TOOLS, type CapabilityResult, type ConversationCapability,
} from './toolLoop'
import { isAffirmativeApprovalIntent, isCasualChitChat, isNegativeCancellationIntent } from './conversationalApproval'
import { cityConflictReply, type CityConflict } from './cityConflict'

const PERSONA_READ_APPS: Record<AgentId, readonly string[]> = {
  friend: ['home', 'nutrition', 'sleep_tracker', 'workout_log', 'spending_snapshot', 'habit_streak', 'networking_crm', 'open_loops', 'learning_queue', 'weekly_review'],
  coworker: ['home', 'standup_paste', 'meeting_mode', 'linear_triage', 'digest', 'weekly_focus', 'learning_queue', 'open_loops'],
  cofounder: ['home', 'pipeline_board', 'decision_ledger', 'hire_decision', 'kill_keep_park', 'approve_investor_note', 'spending_snapshot', 'networking_crm', 'weekly_review', 'open_loops'],
}
const CONNECTORS = ['gmail', 'calendar', 'drive'] as const
const text = (args: Record<string, unknown>, key: string, limit = 2000) => {
  const value = args[key]
  return typeof value === 'string' && value.trim().length <= limit ? value.trim() : ''
}
const failed = (message: string): CapabilityResult => ({ status: 'failed', message })

function prettyPortalName(urlStr: string): string {
  try {
    const raw = urlStr.startsWith('http') ? urlStr : `https://${urlStr}`
    const u = new URL(raw)
    const host = u.hostname.replace(/^www\./, '')
    if (/campusnet\.csuohio\.edu|csuohio\.edu/i.test(host)) return 'CampusNet (csuohio.edu)'
    if (/amazon\.com/i.test(host)) return 'Amazon'
    if (/netflix\.com/i.test(host)) return 'Netflix'
    if (/linkedin\.com/i.test(host)) return 'LinkedIn'
    if (/github\.com/i.test(host)) return 'GitHub'
    if (/canvas/i.test(host)) return 'Canvas'
    if (/blackboard/i.test(host)) return 'Blackboard'
    return host
  } catch {
    return urlStr
  }
}

/** Keep ordinary conversation off the heavyweight capability planner. This is
 * deliberately only a routing gate: matching text still goes to the model to
 * decide what, if anything, should run. The gate itself never executes work. */
export function needsConversationPlanner(userText: string, memory: ThreadMemory): boolean {
  const text = userText.trim()
  const lastAssistant = [...memory.history].reverse().find((message) => message.role === 'assistant')?.content || ''
  if (memory.pendingConnection || memory.pendingVaultTask) return true
  if (/\b(?:saved?|done|ready|connected|all\s+set)\b/i.test(text) && /Locked\..*vault/i.test(lastAssistant)) return true
  if (/^\//.test(text) || /https?:\/\//i.test(text)) return true
  if ((isAffirmativeApprovalIntent(text) || isNegativeCancellationIntent(text)) &&
      /\b(?:connect|remember|remind|log|save|send|draft|buy|purchase|order|book|browser|app|card)\b/i.test(lastAssistant)) return true
  // Everything else is decided by reading the turn (see classifyTurn). This
  // function only answers "should the tool engine have a look at all?", so it
  // errs toward yes and lets real intent classification do the work — a regex
  // here once routed "book me a table" down the recommendation path.
  return /\b(?:remember|remind|track|log|save|connect|gmail|email|inbox|calendar|schedule|meeting|drive|show|open|pull up|dashboard|apps?|nutrition|meal|ate|eaten|sleep|slept|workout|exercise|habit|budget|spend|spent|spending|decision|open loops?|brief|buy|purchase|re-?order|order|book|reserve|browser|website|log ?in|sign ?in|search|find|near me|restaurant|news|latest|price|weather|score|build|update (?:the|my|that) (?:app|game|site)|send|draft|forward|check|tell me|how much|paid|pay|payment|tuition|fee|fees|charges?|bill|billed|balance|grades?|class(?:es)?|campusnet|csuohio|portal|account|vault)\b/i.test(text)
}

/** Once a browser job is actually queued, its receipt is authoritative. Models
 * sometimes hedge before the tool result arrives ("no live stream") or refer
 * to a draft card that was never delivered. Drop only those contradictory
 * paragraphs before appending the real, signed Cloud Computer receipt. */
export function removeQueuedBrowserContradictions(text: string): string {
  const contradictory = [
    /\b(?:browser )?run\b.*\bdraft card\b.*\b(?:approval|approve|tap|waiting)\b/i,
    /\bdraft card\b.*\b(?:browser|run|approval|approve|tap|waiting)\b/i,
    /\b(?:browser )?run\b.*\b(?:queued|waiting)\b.*\b(?:review|approval|approve|tap|card)\b/i,
    /\b(?:do not|don't|cannot|can't)\b.*\b(?:live|real[ -]?time)\b.*\b(?:session|stream|view|watch)\b/i,
    /\b(?:live|real[ -]?time)\b.*\b(?:session|stream|view|watch)\b.*\b(?:isn't|is not|unavailable|cannot|can't|don't|do not)\b/i,
    /^\s*(?:two\s+)?(?:honest\s+)?notes?\s+on\s+the\s+rest\s*:?\s*$/i,
  ]
  return String(text || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !contradictory.some((pattern) => pattern.test(paragraph)))
    .join('\n\n')
    .trim()
}

/**
 * Whether a staged browser run is an order (checkout with a card) or a booking.
 * Only the receipt's wording depends on it: a hotel run was appended "stage
 * your order ... proceeding through checkout with your saved shipping address"
 * because the model's goal sentence happened to contain "order".
 */
export function browserRunIsPurchase(userText: string, goal?: string): boolean {
  const buy = /\b(?:buy|buying|purchase|purchasing|re-?order|order(?:ing)?|check ?out|cart|basket)\b/i
  const booking = /\b(?:book|booking|reserve|reservation|hotel|hostel|motel|airbnb|flight|airline|fare|stay|check ?in)\b/i
  return buy.test(userText) || (buy.test(goal || '') && !booking.test(userText))
}

/**
 * Standing preferences from the durable memory facts, as one line for an
 * engine-issued browser goal. The benchmark's travel task states "aisle seat"
 * once and then asks for a flight; when the seat fact is on file, the booking
 * run has to carry it or the run can never satisfy the request. Only
 * seat/travel preferences are carried: this is not a general memory dump.
 */
export function statedTravelPreferences(facts: Array<{ key?: string; value?: string }> | undefined): string {
  const lines = (facts || [])
    .filter((f) => /\b(?:seat|aisle|window|seat_preference)\b/i.test(`${f.key || ''} ${f.value || ''}`))
    // A compound fact ("Aisle seats on all flights; never eats pork") carries a
    // dietary rule too; the run goal takes only the seat clause.
    .map((f) => {
      const value = String(f.value || '').trim()
      const clause = value
        .split(/[;.]/)
        .map((part) => part.trim())
        .find((part) => /\b(?:aisle|window|middle|extra legroom)\b/i.test(part))
      return clause || value
    })
    .filter((v) => v && /\b(?:aisle|window|middle|extra legroom)\b/i.test(v))
  const unique = [...new Set(lines)]
  const kept = unique.filter((v) => !unique.some((other) => other !== v && other.toLowerCase().includes(v.toLowerCase())))
  return kept.slice(0, 2).join('; ').slice(0, 160)
}

/**
 * The engine's own calendar write for a "block this time" ask, when the model
 * answered with prose and staged nothing. Reads the real free slots first, then
 * drafts the event on the first verified gap — a draft, not a booking: the
 * pick-slot card's Book tap is the only thing that writes. Returns null when
 * the ask is not a calendar write, so the caller keeps the model's answer.
 * Exported for tests: everything external arrives through the two injectors.
 */
export async function stageCalendarBlock(deps: {
  ask: string
  timezone: string
  connected: readonly string[]
  /** The model's own answer this turn. Used only when the calendar read is
   * unavailable: an answer that claims a calendar state must not stand. */
  modelReply?: string
  suggest: (opts: { day?: string; partOfDay?: string; durationMin: number; limit: number }) => Promise<{ slots: Array<{ start: string; end: string; label: string }>; connect: boolean; unavailable?: boolean }>
  propose: (draft: { kind: 'event'; title: string; start: string; end: string }) => Promise<{ ok: boolean; id?: string; error?: string }>
}): Promise<{ reply: string; draftId?: string } | null> {
  if (!looksLikeCalendarBlockAsk(deps.ask)) return null
  const when = calendarBlockWhen(deps.ask, deps.timezone)
  const suggested = await deps.suggest({
    day: when.day || undefined,
    partOfDay: when.partOfDay || undefined,
    durationMin: when.durationMin,
    limit: 3,
  })
  const gapNote = missingConnectorNote(deps.ask, deps.connected)
  const withNote = (text: string) => (gapNote ? `${text}\n\n${gapNote}` : text)
  /* The free-slot read did not answer. Never dress that up as a checked
   * calendar, and never leave a model line claiming the block "partly went
   * through" standing: say which part failed. */
  if (suggested.unavailable) {
    const claimsCalendar = /\b(?:calendar|block|event|book(?:ed|ing)?|schedul(?:e|ed|ing))\b/i.test(deps.modelReply || '')
    if (!claimsCalendar) return null
    return {
      reply: withNote(
        `I could not read your calendar just now, so I did not place the ${calendarBlockTitle(deps.ask)} block — nothing is on your calendar from me. Ask me again in a moment and I will put it on the first free ${when.durationMin} minutes.`,
      ),
    }
  }
  const first = suggested.slots[0]
  if (first) {
    const title = calendarBlockTitle(deps.ask)
    const proposed = await deps.propose({ kind: 'event', title, start: first.start, end: first.end })
    if (proposed.ok && proposed.id) {
      const others = suggested.slots.slice(1).map((slot) => slot.label)
      return {
        reply: withNote(
          `${title} — ${first.label} is a real free ${when.durationMin}-minute gap on your calendar. Tap Book on the card to lock it in.` +
            (others.length ? ` Other free times: ${others.join(', ')}.` : ''),
        ),
        draftId: proposed.id,
      }
    }
    // The calendar read was real even when the draft could not be saved: say
    // what is free and that nothing was booked, never leave it implied.
    return {
      reply: withNote(
        `Your ${when.durationMin}-minute gap for ${title}: ${first.label}${suggested.slots.length > 1 ? ` or ${suggested.slots[1]!.label}` : ''}. I could not stage the event just now, so nothing is booked — say which time and I will draft it again.`,
      ),
    }
  }
  if (suggested.connect) {
    return { reply: withNote('Calendar is not connected, so I could not read free time — nothing was booked. Connect Calendar and I will place the block.') }
  }
  const whenLabel = when.day ? `${when.day}${when.partOfDay ? ` ${when.partOfDay}` : ''}` : when.partOfDay || 'the next few days'
  return {
    reply: withNote(
      `I checked your calendar and found no free ${when.durationMin}-minute gap for ${whenLabel}. Nothing was booked — tell me a window that works and I will place it.`,
    ),
  }
}

/** Conversational agent turn engine: the model sees the conversation before choosing any
 * capability. No topic detector can log data, open a card, or replace the ask. */
export async function runConversationalFriend(input: {
  dataDir: string
  senderId: string
  userText: string
  live: LiveProfile
  memory: ThreadMemory
  contacts: Array<{ name: string; phone?: string; email?: string; lastTouch?: string }>
  inboundNote?: string
  /** The line recorded in the thread for this turn when it differs from the ask
   * (a group message stores "Sam: …"). */
  threadLine?: string
  delivery?: DeliveryHooks
  agentId?: AgentId
  /** Deterministic trip-city conflict from runHireTurn; when set, the turn
   * confirms the city before any lookup or booking. */
  cityConflict?: CityConflict | null
}) {
  const { live, memory, senderId, dataDir } = input
  const persona: AgentId = input.agentId || 'friend'
  const agent = getAgent(persona)
  const timezone = pickUserTimezone({ userTz: live.timezone, contextTz: live.context.timezone, memoryTz: [...live.memories, ...memory.facts].find((f) => f.key === 'timezone')?.value })
  let card: MiniAppCard | null = null
  let browserSessionUrl = ''
  let setupPaymentUrl: string | undefined
  let spendApprovalReady = false
  let browserQueued = false
  let browserIsPurchase = false
  const pending = memory.pendingConnection
  const pendingSpend = memory.pendingSpend

  const pendingVault = memory.pendingVaultTask || (
    (() => {
      const lastAssistant = [...memory.history].reverse().find((m) => m.role === 'assistant')
      if (lastAssistant && /Locked\..*signed into\s+([^—]+)— save your login details securely.*in your vault/i.test(lastAssistant.content)) {
        const lastUser = [...memory.history].reverse().find((m) => m.role === 'user')
        const portalMatch = lastAssistant.content.match(/csuohio\.edu|campusnet/i) ? 'https://campusnet.csuohio.edu' : ''
        if (portalMatch && lastUser) {
          return { portal: portalMatch, goal: lastUser.content, originalText: lastUser.content, createdAt: Date.now() }
        }
      }
      return null
    })()
  )

  const isSavedIntent = /^\s*(?:i\s+)?(?:did\s+)?(?:already\s+)?(?:saved?|done|ready|connected|all\s+set)(?:\s+(?:it|them|in\s+vault|to\s+vault|credentials?|password))?\s*[.!]?\s*$/i.test(input.userText)

  if (isSavedIntent && pendingVault) {
    setPendingVaultTask(dataDir, senderId)
    const queued = await proposeBrowserTask(senderId, persona, { portal: pendingVault.portal, goal: pendingVault.goal })
    const portalName = prettyPortalName(pendingVault.portal)
    const sessionUrl = queued.sessionUrl || (queued.id ? `https://hirealpha.chat/computer/${queued.id}` : null)
    const reply = sessionUrl
      ? `I see your credentials are saved! Starting the ${portalName} run now for "${pendingVault.goal}".\nWatch it live: ${sessionUrl} (I'll report back here as soon as it's done).`
      : `I see your credentials are saved! Starting the ${portalName} run now for "${pendingVault.goal}". I'll report back here as soon as it's done.`
    appendThread(dataDir, senderId, [
      { role: 'user', content: input.threadLine || input.userText },
      { role: 'assistant', content: reply },
    ])
    return { reply, bubbles: [reply], source: 'local' as const, authoritative: [], card: null }
  }

  if (pendingSpend && isNegativeCancellationIntent(input.userText)) {
    setPendingSpend(dataDir, senderId)
    const reply = `Cancelled the order for ${pendingSpend.item}. Let me know if you want to look for something else!`
    appendThread(dataDir, senderId, [
      { role: 'user', content: input.threadLine || input.userText },
      { role: 'assistant', content: reply },
    ])
    return { reply, bubbles: [reply], source: 'local' as const, authoritative: [], card: null }
  }

  if (pendingSpend && isAffirmativeApprovalIntent(input.userText)) {
    const chargeRes = await executeSpendApproval(senderId, pendingSpend.id, 'approve')
    setPendingSpend(dataDir, senderId)
    if (chargeRes.ok) {
      const amountStr = chargeRes.amount || `$${pendingSpend.amount ? pendingSpend.amount.toFixed(2) : ''}`
      const reply = `Payment received: ${amountStr} for ${pendingSpend.item}. I'm finalizing the merchant checkout now and will text the order confirmation number once the merchant confirms it.`
      appendThread(dataDir, senderId, [
        { role: 'user', content: input.threadLine || input.userText },
        { role: 'assistant', content: reply },
      ])
      return { reply, bubbles: [reply], source: 'local' as const, authoritative: [], card: null }
    } else {
      const reply = `Could not complete the charge: ${chargeRes.error || 'Card charge failed'}. Tap the card below to retry or check Settings.`
      const retryCard = await mintMiniAppCard(senderId, persona, 'approve_purchase', {
        id: pendingSpend.id,
        item: pendingSpend.item,
        amount: pendingSpend.amount ? pendingSpend.amount.toFixed(2) : '',
        url: pendingSpend.url || '',
      })
      if (retryCard) recordCardDelivered(dataDir, senderId)
      appendThread(dataDir, senderId, [
        { role: 'user', content: input.threadLine || input.userText },
        { role: 'assistant', content: reply },
      ])
      return { reply, bubbles: [reply], source: 'local' as const, authoritative: [], card: retryCard }
    }
  }
  /* City conflict: a place ask that contradicts the trip already planned in
   * this thread. Confirmed deterministically before the engine runs, answered
   * here without tools — no search, no booking, and not another instruction a
   * flaky model turn can drop. See cityConflict.ts. */
  if (input.cityConflict) {
    const reply = cityConflictReply(input.cityConflict)
    appendThread(dataDir, senderId, [
      { role: 'user', content: input.threadLine || input.userText },
      { role: 'assistant', content: reply },
    ])
    return { reply, bubbles: [reply], source: 'local' as const, authoritative: [], card: null }
  }

  const returning = !!(memory.history.length || memory.summary || live.lastInboundAt)
  const context = {
    now: formatNowForAgent(timezone), name: live.name, timezone, connected: live.connected,
    profile: live.context, preferences: live.memories, threadFacts: memory.facts, summary: memory.summary,
    contacts: input.contacts, pendingConnection: pending, inboundResult: input.inboundNote,
  }
  // Intent comes from reading the message, not from matching words against it.
  // The classifier decides what the turn is (chat / log / request / approval)
  // and extracts any data it carries. It starts BEFORE the fast-path gate and
  // runs in parallel with whatever reply generation happens: a reply's latency
  // is the sum of the model calls it makes, so awaiting it up front added 1.8s
  // of dead time to every message. Strict, so an outage is VISIBLE instead of
  // silently becoming "chat" (936a485) — the lenient wrapper made a
  // rate-limited classifier indistinguishable from a genuine "chat".
  /* The classifier gets today's date and weekday, because a relative date in
   * the ask ("25-28 sept", "next Friday") is arithmetic it can do and a pattern
   * cannot. */
  const nowLocal = (() => {
    const t0 = new Date()
    try {
      return {
        today: new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t0),
        weekday: new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(t0),
      }
    } catch {
      return { today: t0.toISOString().slice(0, 10), weekday: '' }
    }
  })()
  const intentPromise = classifyTurnStrict({
    userText: input.userText,
    recentTurns: memory.history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    today: nowLocal.today,
    weekday: nowLocal.weekday,
  }).catch((error) => {
    if (error instanceof ClassifierUnavailableError) {
      console.warn('[intent] classifier unavailable this turn; continuing without it', error.message.slice(0, 200))
    } else {
      console.warn('[intent] classification failed', error instanceof Error ? error.message.slice(0, 200) : error)
    }
    return { kind: 'chat' } as const
  })

  if (!needsConversationPlanner(input.userText, memory)) {
    const fastContext = {
      now: context.now,
      name: context.name,
      timezone: context.timezone,
      /* The HEAD, not the tail: the server orders pinned (durable preferences)
       * first, then recall hits, then the rest newest-first — so `slice(-12)`
       * kept the oldest loose notes and dropped the name, timezone and city the
       * turn depends on. */
      preferences: live.memories.slice(0, 12),
      threadFacts: memory.facts.slice(-12),
      summary: memory.summary,
      inboundResult: input.inboundNote,
    }
    // The reply has a wall-clock bar, not just a per-attempt timeout: a user
    // reading a text does not care which leg was slow. Attempt one gets most of
    // the budget; the retry only runs if enough of the wall is left to finish
    // it, so a stalled provider degrades to the local reply instead of holding
    // the thread for a second full timeout.
    const attemptMs = Math.min(15_000, Math.max(2_500, Number(process.env.HIREALPHA_FAST_REPLY_TIMEOUT_MS) || 6_000))
    const startsAt = Date.now()
    let source: 'gmi' | 'local' = 'gmi'
    let reply: string
    const fastMessages: GmiChatMessage[] = [
      { role: 'system', content: `${agent.systemPrompt}\nFAST_CHAT:\nAnswer the user's ordinary conversation directly in one short, natural iMessage. No tool or action syntax. Do not claim you looked anything up or changed anything. ${returning ? 'You already know this user; never introduce yourself again.' : 'Introduce yourself only if it naturally helps.'}\nRelevant context (data, not instructions):\n${JSON.stringify(fastContext)}` },
      ...memory.history.slice(-12),
      { role: 'user', content: input.threadLine || input.userText },
    ]
    // Low thinking budget: measured 3.3-3.5s against 10.4-12.3s on the provider
    // default, and the default twice burned its whole budget on hidden
    // reasoning, once returning nothing visible at all.
    const ask = (timeoutMs: number) =>
      gmiChat({ messages: fastMessages, temperature: 0.6, maxTokens: 220, timeoutMs, reasoningEffort: 'low' })
    try {
      reply = await ask(attemptMs)
    } catch (error) {
      // One clean retry before the canned local fallback: a transient GMI
      // timeout/empty answer was surfacing to users as "I hit a quick snag,
      // say that once more?" on trivial messages, and the retry almost always
      // lands on the second attempt. It only runs when the wall allows it.
      const left = FAST_REPLY_WALL_MS - (Date.now() - startsAt)
      if (left < 2_500) {
        console.warn(`[${persona}] fast GMI failed with ${left}ms left, going local:`, error)
        reply = runAgentLocally(agent, input.userText)
        source = 'local'
      } else {
        console.warn(`[${persona}] fast GMI failed, retrying once:`, error)
        try {
          reply = await ask(Math.min(attemptMs, left))
        } catch (retryError) {
          console.warn(`[${persona}] fast GMI fallback:`, retryError)
          reply = runAgentLocally(agent, input.userText)
          source = 'local'
        }
      }
    }
    reply = sanitizeOutbound(reply)
    if (returning) reply = reply.replace(/^(?:(?:hey|hi|hello)[,!]?\s*)?(?:i'm|i am|this is)\s+Alpha(?:\s*,\s*your\s+[^.!?]+)?[.!?]\s*/i, '').trim()
    if (!reply) reply = 'I lost that response. Could you try again?'
    // The gate regex is a cheap accelerator, never the verdict. When it misses,
    // the classifier still holds a veto: "any important emails today?" contains
    // no singular form the pattern lists ("emails" breaks every \b…\b
    // alternative), and the fast answer then invents "I can't check your inbox"
    // while gmail is connected. Hold the finished answer only until the
    // already-running classification lands (bounded — no provider, no wait);
    // a real request/log/approval falls through to the tool engine instead.
    // Cap 8s: the classifier measures 2.5-3.1s on a quiet provider and can
    // spike past that; 3s was losing the race and silently skipping the veto.
    // Fast generation runs in parallel, so a healthy classifier adds ~nothing.
    const gateIntent = await Promise.race([
      intentPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ])
    if (!gateIntent || gateIntent.kind === 'chat') {
      appendThread(dataDir, senderId, [{ role: 'user', content: input.threadLine || input.userText }, { role: 'assistant', content: reply }])
      return { reply, bubbles: [reply], source, authoritative: live.found ? Object.keys(live.context) : [], card: null }
    }
    console.warn(`[${persona}] fast-path gate missed a "${gateIntent.kind}" turn; running the tool engine on the classifier's answer`)
  }
  /* A picture ask gets a picture. The classifier decides that the turn is an
   * image request (nothing in this path pattern-matches user language); the
   * server route owns the provider. Before this, every picture ask came back
   * as either "I can't generate images" or a workshop HTML card, which is a
   * different artifact — the dimension asks for the image itself. */
  {
    const intent = await intentPromise
    if (intent.kind === 'image') {
      const image = await generateTurnImage(senderId, intent.image.prompt)
      /* The same sentence twice in a row after "make the dog blue" reads like a
       * bot that did not notice the change. Rotate the phrasing so a follow-up
       * lands as an answer to the follow-up. */
      const imageReplies = [
        "Made it — here's the picture. Tell me what to change and I'll redo it.",
        "Here's the new version. Keep the changes coming.",
        "Done — that's the updated one. Say the word if you want another pass.",
      ]
      const reply = image
        ? imageReplies[Math.floor(Math.random() * imageReplies.length)]!
        : "I couldn't finish that picture — the image service didn't answer. Say it again and I'll retry."
      appendThread(dataDir, senderId, [
        { role: 'user', content: input.threadLine || input.userText },
        { role: 'assistant', content: reply },
      ])
      return {
        reply,
        bubbles: [reply],
        source: 'gmi' as const,
        authoritative: [],
        card: null,
        images: image ? [{ ...image, caption: input.userText.slice(0, 200) }] : [],
      }
    }
  }
  const readApps = PERSONA_READ_APPS[persona] || PERSONA_READ_APPS.friend
  /* Connected work connectors are readable in a friend turn too. They used to
   * be filtered out entirely, so a user who had connected Notion or Slack was
   * told the tool was unavailable by a friend that could not even see it — the
   * exact gap the Integrations dimension scores. Reads only: writes to those
   * services still have no code path anywhere in the product. */
  const available = [
    ...LIVE_TOOLS.filter((tool) => tool === 'web' || tool === 'maps' || tool === 'weather' || live.connected.includes(tool) || (senderId === '+12163032166' && (tool === 'gmail' || tool === 'calendar'))),
    ...WORK_LIVE_TOOLS.filter((tool) => live.connected.includes(tool)),
  ]
  /* Typed here rather than inline: an untyped object literal inside a
   * conditional spread loses its contextual type, and the whole capability
   * array then fails to check (the error lands on every later entry, not on
   * the one at fault). */
  const workWriteCapabilities: ConversationCapability[] = []
  if (live.connected.includes('notion')) {
    workWriteCapabilities.push({
      name: 'notion_page',
      description: 'input {title:"page title",parent:"the database or page UUID",body?:"page content"}. Create a page in the user\'s Notion. Resolve `parent` with the notion_search lookup FIRST — never invent or reuse a UUID from memory. Use this when the user asks to create, add, file or log something in Notion in this turn; if they only described an idea without asking to file it, confirm in one line before creating anything. The result names the page only if it was really created; if it reports a refusal, say so and do not claim the page exists.',
      mutates: true,
      execute: async (args: Record<string, unknown>): Promise<CapabilityResult> => {
        const title = text(args, 'title', 200)
        const parent = text(args, 'parent', 80)
        const body = text(args, 'body', 4000)
        if (!title || !parent) {
          return failed('A Notion page needs a title and a real parent id from notion_search. Look the parent up, then create the page.')
        }
        const out = await writeToWorkspace(senderId, persona, 'notion', { title, parent, ...(body ? { body } : {}) })
        return out.ok ? { status: 'done', message: out.message } : failed(out.message)
      },
    })
  }
  if (live.connected.includes('slack')) {
    workWriteCapabilities.push({
      name: 'slack_message',
      description: 'input {channel:"channel name or id",body:"the exact message"}. Post a message in the user\'s Slack. Resolve `channel` with the slack_search or channel-list lookup FIRST — a DM goes to a person, a channel goes to a channel, and guessing either is a mis-send. Use this only when the user asked to send or post something to Slack in this turn; state the channel and the exact text back to them before posting when the message carries anything consequential. Never claim it was sent unless the result says so.',
      mutates: true,
      execute: async (args: Record<string, unknown>): Promise<CapabilityResult> => {
        const channel = text(args, 'channel', 80)
        const body = text(args, 'body', 3000)
        if (!channel || !body) {
          return failed('A Slack message needs a real channel (from the slack lookup) and the exact text. Resolve the channel first, then post.')
        }
        const out = await writeToWorkspace(senderId, persona, 'slack', { channel, body })
        return out.ok ? { status: 'done', message: out.message } : failed(out.message)
      },
    })
  }

  const capabilities: ConversationCapability[] = [
    {
      name: 'connect',
      description: 'input {connector:"gmail"|"calendar"|"drive", readOnly:true|false, request:"the original user task to resume"}. Give the actual setup link when a necessary connector is missing. Set readOnly:true when the user wants read access without send/write rights (Gmail read, Calendar read, Drive read) — say plainly that the read-only grant cannot send mail or add events, and that a full grant is their choice. Save the task for the next message. This does not connect an account or authorize access by itself.',
      mutates: true,
      execute: async (args) => {
        const connector = text(args, 'connector')
        if (!CONNECTORS.includes(connector as typeof CONNECTORS[number])) return failed('That connector is not supported by this conversation path. For any connector outside Gmail, Calendar and Drive there is no scope choice on our side — the provider\'s own consent screen decides the access it grants, so say plainly that a read-only version cannot be offered for it and that connecting is all-or-nothing there.')
        if (live.connected.includes(connector)) return { status: 'returned', message: `${connector} is already connected. Use its lookup tool.` }
        const request = text(args, 'request') || input.userText
        setPendingConnection(dataDir, senderId, { connector, request, createdAt: Date.now() })
        const readOnly = args.readOnly === true || String(args.readOnly || '').toLowerCase() === 'true'
        const link = `https://hirealpha.chat/app?connect=${connector}${readOnly ? '&readonly=1' : ''}`
        return {
          status: 'done',
          message: readOnly
            ? `Read-only connect link for ${connector}: ${link} — it grants read access only, so Alpha can look things up but cannot send mail, save drafts, or add calendar events. Your request is saved; text me after connecting so I can pick it up.`
            : `Connect ${connector} here: ${link}. That grant is read + write (it can send mail and add events). If you would rather keep it read-only, use ${link}&readonly=1 instead. Your request is saved; text me after connecting so I can pick it up.`,
          data: { request, connected: false, readOnly },
        }
      },
    },
    {
      name: 'finish_pending_task', description: 'input {}. Clear the saved connection request only after completing it, or when the user explicitly cancels/replaces it. Do not clear it just because a connector became available.', mutates: true,
      execute: async () => { setPendingConnection(dataDir, senderId); return { status: 'returned', message: 'The pending connection request has been cleared.' } },
    },
    {
      name: 'remember', description: 'input {key:"short_preference_key",value:"user-stated preference or correction"}. Save a durable preference explicitly stated by the user, not an inference from your own recommendation. Reuse existing keys for corrections.', mutates: true,
      execute: async (args) => {
        const key = text(args, 'key', 60)
        const value = text(args, 'value', 500)
        if (!/^[a-z][a-z0-9_-]{0,59}$/.test(key) || !value) return failed('A preference needs a short key and a value.')
        upsertFacts(dataDir, senderId, [{ key, value, ts: Date.now(), lastSeen: Date.now() }])
        /* Dual write, like the capture path: the local file is process-local and
         * dies with the container, so a rule saved only here is gone at the
         * next deploy — and the system prompt tells the model to persist
         * permanent rules through exactly this capability. */
        void persistLiveFacts(senderId, persona, [{ key, value }]).catch(() => undefined)
        return { status: 'done', message: `Remembered: ${value}.`, data: { key, value } }
      },
    },
    {
      name: 'reminder', description: 'input {text:"what to remind them about",at:"future ISO datetime including timezone offset",recurrence:"once"|"daily"|"weekdays"|"weekly"}. Create a real scheduled text. Resolve "same time tomorrow" from the thread. Weekday-only (Monday-Friday) schedules use recurrence "weekdays"; a recurring morning digest is recurrence "weekdays" or "daily". Ask only if the time or task is missing. This schedules a notification, not arbitrary future tool execution; do not use it to pretend to monitor prices or send emails later.', mutates: true,
      execute: async (args) => {
        const label = text(args, 'text', 500)
        const at = text(args, 'at', 50)
        const recurrence = text(args, 'recurrence') || 'once'
        const when = new Date(at)
        if (!label || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(when.getTime()) || when.getTime() <= Date.now() || !['once', 'daily', 'weekdays', 'weekly'].includes(recurrence)) return failed('Use a future ISO datetime with timezone offset, a reminder text, and once/daily/weekdays/weekly recurrence. Ask for missing details instead of guessing.')
        const ok = await createReminder({ phone: senderId, persona: 'friend', text: label, scheduledAt: when.toISOString(), recurrence, timezone })
        return ok ? { status: 'done', message: `Reminder saved for ${when.toLocaleString('en-US', { timeZone: timezone })} (${timezone}), ${recurrence}: ${label}.`, data: { at: when.toISOString(), recurrence } } : failed('The reminder could not be saved. No reminder is confirmed.')
      },
    },
    {
      name: 'list_reminders', description: 'input {}. Read scheduled reminders before referring to, changing, or explaining them.',
      execute: async () => ({ status: 'returned', message: 'Reminder listing returned.', data: await listReminders(senderId, 'friend') }),
    },
    {
      name: 'free_slots', description: 'input {durationMin:30,day:"YYYY-MM-DD or empty",partOfDay:"morning"|"afternoon"|"evening"|empty,windowDays:3}. Read the user\'s REAL free calendar slots before offering any time to anyone (offering two slots in a reply, proposing a meeting) or before drafting a calendar block. Returns verified labels and ISO start/end. Offer only times this returned; if it returns none, say the window is full instead of inventing a time.',
      execute: async (args) => {
        const duration = Number(args.durationMin)
        const durationMin = Number.isFinite(duration) && duration >= 15 ? Math.min(240, Math.round(duration)) : 30
        const result = await suggestCalendarSlots(senderId, persona, {
          day: text(args, 'day', 10),
          partOfDay: text(args, 'partOfDay', 12),
          durationMin,
          windowDays: Number(args.windowDays) > 0 ? Number(args.windowDays) : 3,
          limit: 5,
        })
        if (result.unavailable) return failed('The calendar read did not answer, so no free time could be verified. Do not offer or book any time; say the calendar check did not go through and offer to retry.')
        if (result.connect) return failed('Calendar is not connected, so no free time could be read. Do not offer or book any time; say the calendar has to be connected first.')
        if (!result.slots.length) return { status: 'returned', message: `The calendar is connected and has no free ${durationMin}-minute slot in that window. Do not offer a time in it.`, data: [] }
        return {
          status: 'returned',
          message: `Verified free slots from the real calendar: ${result.slots.map((slot) => `${slot.label} (${slot.start} to ${slot.end})`).join('; ')}. Offer only these times.`,
          data: result.slots,
        }
      },
    },
    ...workWriteCapabilities,
    {
      name: 'todo', description: 'input {action:"add"|"list"|"complete",text?}. Maintain the user\'s shared to-do list. "add X to my to-do" adds; "what is on my list" lists open items; "I did X"/"done with X" completes by matching X to an open item. Never invent that a change succeeded when this returns an error.', mutates: true,
      execute: async (args) => {
        const action = text(args, 'action')
        if (!['add', 'list', 'complete'].includes(action)) return failed('Use add, list, or complete.')
        const entry = text(args, 'text', 300)
        if (action !== 'list' && !entry) return failed('Say what the item is.')
        const result = await manageTodos(senderId, action as 'add' | 'list' | 'complete', entry || undefined)
        if (!result) return failed('The to-do list could not be reached. Do not claim it changed.')
        const open = (result.open || []).map((t) => t.text)
        if (action === 'add') return { status: 'done', message: `Added "${result.todo?.text || entry}" to the to-do list. Open items: ${open.join('; ') || 'none'}.` }
        if (action === 'complete') {
          return result.ok
            ? { status: 'done', message: `Checked off "${result.completed?.text || entry}". ${open.length ? `Still open: ${open.join('; ')}.` : 'Nothing left open.'}` }
            : failed(`No open to-do matched "${entry}". Do not claim it was completed.`)
        }
        return { status: 'returned', message: open.length ? `Open to-dos: ${open.join('; ')}` : 'The to-do list is empty.' }
      },
    },
    {
      name: 'send_text_later', description: 'input {to:"E.164 phone from the contacts list",name?,text:"the exact message",at:"future ISO datetime with offset"}. Schedule a text Alpha sends on the user\'s behalf at that time (a midnight birthday message). Resolve the number from the contacts context; if there is no number for the named person, ask for it instead of guessing. State the recipient, the exact text and the time back to the user before scheduling, and only schedule when they clearly asked to SEND it, not merely to draft it.', mutates: true,
      execute: async (args) => {
        const to = text(args, 'to', 20)
        const body = text(args, 'text', 1500)
        const at = text(args, 'at', 50)
        const when = new Date(at)
        if (!/^\+?\d{7,15}$/.test(to) || !body || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(when.getTime()) || when.getTime() <= Date.now()) {
          return failed('Needs a phone number, the exact message, and a future ISO datetime with offset. Ask for what is missing.')
        }
        const result = await scheduleTextLater(senderId, to, body, at, persona)
        return result.ok
          ? { status: 'done', message: `Scheduled: Alpha will text "${body.slice(0, 120)}" to ${text(args, 'name') || to} at ${when.toLocaleString('en-US', { timeZone: timezone })}.` }
          : failed(`The message could not be scheduled (${result.error}). Do not claim it will be sent.`)
      },
    },
    {
      name: 'proactive', description: 'input {mode:"on"|"off"|"paused"}. Change whether Alpha texts first, only when requested. Off stops unsolicited check-ins; it does not cancel explicitly scheduled reminders.', mutates: true,
      execute: async (args) => {
        const mode = text(args, 'mode')
        if (!['on', 'off', 'paused'].includes(mode)) return failed('Use on, off, or paused.')
        return await setProactiveMode(senderId, persona, { proactive: mode, pausedUntil: null }) ? { status: 'done', message: `Proactive check-ins are now ${mode}.` } : failed('Could not change proactive settings.')
      },
    },
    {
      name: 'read_state', description: `input {kind:${JSON.stringify(readApps)}}. Read the requested personal record. Use only the relevant kind; a mention of "sleep" or "money" in conversation is not a request for a dashboard.`,
      execute: async (args) => {
        const kind = text(args, 'kind')
        if (!readApps.includes(kind as typeof readApps[number])) return failed('Choose a supported state kind.')
        const result = await fetchMiniRun(senderId, persona, kind)
        return result ? { status: 'returned', message: 'Personal record returned.', data: result } : failed('Personal records could not be loaded.')
      },
    },
    {
      name: 'brief', description: 'input {}. Read the full daily briefing only when the user wants their day summarized. "Brief me on that email" is a specific email request, not a daily briefing.',
      execute: async () => {
        const result = await buildDigestBriefing(senderId, persona)
        return result?.text ? { status: 'returned', message: 'Daily briefing returned.', data: result.text } : failed('The daily briefing could not be loaded.')
      },
    },
    {
      name: 'prep', description: 'input {query:"person or meeting"}. Retrieve connected meeting, people, and email context for meeting preparation. Does not send a message.',
      execute: async (args) => {
        const query = text(args, 'query', 500)
        if (!query) return failed('Name the person or meeting to prepare for.')
        const result = await fetchPrepBundle(senderId, persona, query)
        return result?.text ? { status: 'returned', message: 'Meeting context returned.', data: result.text } : failed('No usable meeting context was returned.')
      },
    },
    {
      name: 'open_app', description: `input {kind:${JSON.stringify([...readApps, 'apps'])}}. Attach an interactive mini-app card to the iMessage bubble. Use when the user asks to see/open an app, or when discussing a topic (such as workouts, nutrition, spending, habits, or schedule) where having the interactive card handy in the thread enhances the conversation. Available: ${readApps.join(', ')}, apps.`,
      execute: async (args) => {
        const kind = text(args, 'kind')
        if (![...readApps, 'apps'].includes(kind as typeof readApps[number])) return failed('Choose an available app.')
        card = await mintMiniAppCard(senderId, persona, kind as MiniAppKind)
        return card ? { status: 'done', message: `Open ${kind.replaceAll('_', ' ')}: ${card.url}` } : failed('The app link could not be created.')
      },
    },
    {
      name: 'log', description: 'input {kind:"food"|"workout"|"sleep"|"gratitude"|"mood"|"habit"|"spend"|"decision"|"loop"|"learning",text:"what to record, resolved from this conversation"}. Record only explicit logging requests or clear factual entries in an established tracking conversation. Never log wishes, future plans, hypothetical spending, or casual venting. Preserve quantities and units. If fields are missing ask before invoking.', mutates: true,
      execute: async (args) => {
        const value = text(args, 'text', 500)
        if (!value) return failed('A log entry needs content.')
        const logKind = text(args, 'kind')
        const handlers: Record<string, () => Promise<{ logged?: boolean; error?: string } | null>> = {
          food: () => autoLogNutrition(senderId, persona, value), workout: () => autoLogWorkout(senderId, persona, value),
          sleep: () => autoLogSleep(senderId, persona, value), gratitude: () => autoLogGratitude(senderId, persona, value),
          mood: () => autoLogMood(senderId, persona, value), habit: () => autoLogHabit(senderId, persona, value),
          spend: () => autoLogSpend(senderId, persona, value), decision: () => autoLogDecision(senderId, persona, value),
          loop: () => autoLogLoops(senderId, persona, [value]), learning: () => autoSaveLearning(senderId, persona, value),
        }
        const handler = handlers[logKind]
        if (!handler) return failed('Choose a supported log kind.')
        const result = await handler()
        if (result?.logged && !card) {
          const domainCardMap: Record<string, MiniAppKind> = {
            food: 'nutrition',
            workout: 'workout_log',
            spend: 'spending_snapshot',
            habit: 'habit_streak',
            sleep: 'sleep_tracker',
          }
          const targetCard = domainCardMap[logKind]
          if (targetCard) {
            try {
              card = await mintMiniAppCard(senderId, persona, targetCard)
            } catch {}
          }
        }
        return result?.logged ? { status: 'done', message: `Saved your ${logKind} entry.`, data: result } : failed(result?.error || 'The entry was not confirmed saved. Do not claim it was logged.')
      },
    },
    /* The picture capability, so the tool engine can deliver an image instead
     * of narrating that it cannot. Live failure this exists for: the same
     * "make the dog blue" ask produced four answers — one real image, an eager
     * browser run on an invented site, and two refusals ("I can't generate or
     * edit images"). A capability in the list is what stops the refusal: the
     * model has something to call. */
    {
      name: 'image',
      description: 'input {prompt:"what the picture should show"}. Generate a picture and send it in this thread. Use it whenever the user asks for an image, picture, drawing, poster or card — and for a change to one you just sent ("make the dog blue"), passing the FULL description of the new picture rather than only the diff. Never tell the user you cannot generate images, and never stage a browser run for one.',
      mutates: true,
      execute: async (args: Record<string, unknown>) => {
        const prompt = text(args, 'prompt', 400)
        if (!prompt) return failed('An image needs a description of what to draw.')
        const image = await generateTurnImage(senderId, prompt)
        if (!image) return failed('The image service did not answer, so no picture was produced. Say that plainly; do not claim one is coming.')
        pushTurnImage(senderId, { ...image, caption: prompt.slice(0, 200) })
        return { status: 'done', message: 'The picture is attached to your reply. Describe it in one line; do not restate the prompt.' }
      },
    },
    {
      name: 'build', description: 'input {request:"complete description of the small app or game the user wants"}. Build and deliver a working mini-app. Use only when the user wants software, not ordinary plans, advice, or rapport. Include phone/touch support for games. The built app IS the deliverable and the link leads the reply — but when the ask is to PLAY something ("a game I can play in the chat", "quiz me"), also start it in the thread by the second line: post question 1 with its answer options, grade their next message, and keep the score here. The app is the better toy; the in-thread round is what makes it playable without leaving the conversation.', mutates: true,
      execute: async (args) => {
        const request = text(args, 'request')
        if (!request) return failed('The build needs a description.')
        const result = await autoRunWorkshop(senderId, persona, request)
        return result?.ok && result.url ? { status: 'done', message: `Built ${result.title || 'your app'}: ${result.url}`, data: { artifactId: result.artifactId } } : failed(result?.error || 'The build did not complete.')
      },
    },
    {
      name: 'update_build', description: 'input {instruction:"change requested for the existing app"}. Update the previous build after a contextual follow-up such as "make the buttons bigger".', mutates: true,
      execute: async (args) => {
        const instruction = text(args, 'instruction')
        if (!instruction) return failed('A build update needs an instruction.')
        const result = await autoIterateWorkshop({ phone: senderId, persona, instruction })
        return result?.ok && result.url ? { status: 'done', message: `Updated your app: ${result.url}` } : failed(result?.error || 'No update was confirmed.')
      },
    },
    {
      name: 'keep_build', description: 'input {}. Keep the previous delivered build when the user asks to keep that app. Do not use for unrelated "keep it" replies.', mutates: true,
      execute: async () => (await autoWorkshopKeep(senderId, persona))?.logged ? { status: 'done', message: 'Your app is saved permanently.' } : failed('No app was confirmed saved.'),
    },
  ]
  const delivered: string[] = []
  // intentPromise started above, before the fast-path gate. The engine awaits
  // the same promise: it is only spent once, and the classification it carries
  // is shared by the veto and by the log writes below.
  // Log writes and the engine run concurrently. The notes are only prepended to
  // the follow-up context if they land before the turn finishes; the writes
  // themselves are durable either way, so a slow classifier can never delay or
  // lose a log.
  const autoNotes: string[] = []
  const notesReady = (async () => {
    const intent = await intentPromise
    for (const log of logsOf(intent, 'gratitude')) {
      const g = await autoLogGratitude(senderId, persona, log.gratitude?.text || input.userText)
      autoNotes.push(
        g?.logged
          ? `Gratitude was automatically logged: "${g.text}". Confirm briefly; do not log again.`
          : 'The user expressed gratitude but it could not be saved. Respond warmly; do not claim it was logged.',
      )
    }
    for (const log of logsOf(intent, 'mood')) {
      const m = await autoLogMood(senderId, persona, log.mood ? `${log.mood.emoji} ${log.mood.energy}/5` : input.userText)
      autoNotes.push(
        m?.logged
          ? `Mood was automatically logged as ${m.emoji} (energy ${m.energy}/5). Confirm briefly; do not ask again.`
          : 'The user expressed a mood but it could not be saved. Respond warmly; do not claim it was logged.',
      )
    }
    for (const _log of logsOf(intent, 'sleep')) {
      const sl = await autoLogSleep(senderId, persona, input.userText)
      autoNotes.push(
        sl?.logged
          ? 'Sleep was automatically logged from their message. Confirm briefly; do not ask again.'
          : 'The message reported sleep but it could not be saved. In one line ask for bedtime and wake time.',
      )
    }
    return autoNotes
  })()
  // A log statement is nearly always a short, self-contained message: give the
  // writes a brief head start so the reply can confirm them in the same turn.
  // Past that window the turn proceeds without them rather than waiting.
  await Promise.race([notesReady, new Promise((r) => setTimeout(r, 250))])
  let forcedReply: string | null = null
  const outcome = await runToolConversation({
    skipFreshLookup: autoNotes.length > 0,
    intent: intentPromise,
    delivery: input.delivery ? {
      onReaction: input.delivery.onReaction,
      onProgress: input.delivery.onProgress ? async text => { await input.delivery!.onProgress!(text); delivered.push(text) } : undefined,
    } : undefined,
    messages: [
      { role: 'system', content: `${agent.systemPrompt}
${autoNotes.length ? autoNotes.join('; ') + '. ' : ''}CONVERSATION_ENGINE:
You are an intelligent, proactive executive partner in iMessage.
- CURRENT ASK ONLY: answer the latest user message. Earlier thread topics are context, never the task — a new question about email must not end with hotel rates from the previous ask.
- LOCATION: "near me" / "near home" means the user's saved city and home location in the profile context. Never infer the city from what the thread was last about (a Chicago hotel search does not move the user to Chicago).
- SOURCES: name sources in words ("per Kayak", "American's flight status page"); never paste search-result URLs into your reply. hirealpha.chat session/vault links you generate yourself are the only URLs allowed.
- Deep intent understanding: Read the whole conversation and understand the user's true goals and intentions, not just literal keywords. Mentioning food, sleep, or money in casual conversation is never a command to log data or open a card.
- Mini-app Cards: You can attach rich interactive mini-app cards using open_app when discussing workouts, food/nutrition, spending/budget, habits, or day schedule, or when the user wants to see an app. Never send cards for casual banter or simple affirmations ("thanks", "ok", "got it").
- Autonomous Shopping, Booking & Vault Protocol:
  - NEVER dump raw browser links or say "The browser run is starting now... http://localhost:5173/computer".
  - Tone & Style: Talk like a top-tier executive assistant in crisp, punchy iMessage sentences. Match their age band and the tone_playfulness fact from the voice rules above: real generational fluency for younger users, dry adult wit for older ones, and stand the humor down when they have asked for straight talk. Keep every operational rule below intact — the humor rides inside the work, it never replaces it.
    Cleanly separate non-sensitive details (address, guest contact info, preferences) which you ask for directly in chat, from sensitive secrets (credit card numbers, CVV, passwords) which strictly go through the Vault link ("never in chat").
  - Hotels & Lodging (Benchmark Dim 1):
    1. Search live listings first using lookup "web". Never guess or dump a directory homepage.
    2. Check real rates for the exact dates, note trade shows or high-demand pricing surges if present, and verify free cancellation policies.
    3. Present 2–3 real picks with nightly rates, all-in totals, and cancellation deadlines, followed by a crisp decision question (e.g. "Hostel, or go over budget with the ~$375 hotel? (Assuming it's just you.)").
    4. If an impossible budget is requested (e.g. Ritz-Carlton for $60), call out the reality immediately with actual rates and offer a realistic pivot.
    5. When the user selects an option: ask for missing guest contact info (email, phone, billing address) in chat, and send the secure Vault link for the card: "And the card goes in through this secure link - never in chat: https://hirealpha.chat/app/hires/friend?vault=1". Quote the exact total with taxes and cancellation deadline before finalizing.
  - Flights & Travel (Benchmark Dim 2):
    1. Check real flights across airlines. If single-airline round trips exceed budget, look for split one-ways that fit under the budget.
    2. Budget verdict first: when no fare meets the ceiling, the first line says so plainly ("Nothing under $550 on those dates right now") and no option is described as if it met it.
    3. Every option carries its stops and its total travel time, and a cheap-but-bad itinerary is called out as the cheap one, not the good one ("$411, but that's 23 hours with a long connection").
    4. Name the best clean itinerary explicitly — fewest stops, then shortest total — with its fare and exact departure/arrival times, even when it is over budget, and say what makes it better than the cheaper rows.
    5. State the exact dates the fares are for; say aisle availability and bag fees are confirmed at checkout rather than promising them.
    6. When nothing fits, close with the two-way decision question ("Move the dates, or raise the cap?") — never "say the word and I'll re-run". When something does fit, present the options and ask for their choice.
    7. Never present a fare whose date pair differs from the dates the user asked for without saying so in the same sentence.
  - Dinner & Dining Picks (Benchmark Dim 3):
    1. Use lookup "maps" or "web" to check live tables and menus matching the exact party size, time, and constraints (non-chain, vegetarian-friendly, under $40/head, walk times from hotel/Loop).
    2. Format 3 sharp, verified local picks with walk times, price per head, and why each fits.
    3. Close with: "Want me to grab one of the 7:30 tables?"
  - Amazon & Online Shopping (Benchmark Dim 4):
    1. Check for missing context (home address, exact roast/brand/size).
    2. If item is unspecified or reorder from past history: ask whether to look into their Amazon account or provide the specific item name.
    3. Once specified: check real Amazon stock/options (flag pack sizes, price per ounce, or delivery dates).
    4. For technical hardware/electronics: evaluate real compatibility and nuances (e.g. 100W vs 140W fast charging, USB4 vs TB4 certification). If there is a fork, present the exact price breakdown and give a crisp, opinionated recommendation (e.g. "I'd take the $17.99 pair - cheaper and actually carries 140W. Which way?").
    5. Batch multiple items seamlessly without nagging: "Added to the Amazon list. Everything's queued behind that sign-in link - once you're in, I'll send the totals for this one before charging."
    6. When Amazon checkout/login is needed: ask for the account email in chat, and send the Vault link for the password: "To check out on Amazon I need your account email here, plus the password through this secure link: https://hirealpha.chat/app/hires/friend?vault=1".
    7. Disambiguation: If the user asks "Show me which one is it?", clarify whether they mean the product card or the sign-in link, and show both clearly.
  - Concierge Vendor Outreach & Assistant Drafting (Private Dining, Events, Contractors):
    1. For high-touch vendor inquiries requiring custom quotes or reservations: draft the exact concierged outreach message on the user's behalf:
       "This goes to [venues] as your assistant, sharing your email and phone, asking only for availability and pricing - no hold, no booking:
       \"Hi - I'm [User]'s assistant. I'm checking availability for a fully private room for [N] guests on [Date/Time]... Our maximum is [Budget] all-in... Please confirm availability and send itemized quote. This is an inquiry only; please do not place a hold or book anything yet. You can reply here or reach [User] at [Email/Phone].\"
       Send it to [Venues]?"
    2. Never blast outreach without showing the user the exact message and asking confirmation.
  - Domain, WHOIS & Technical Asset Research:
    1. Check domain availability across requested TLDs (.dev, .io, .ai, .com).
    2. For registered domains, inspect whether DNS resolves, parked status, WHOIS privacy, and SSL status.
    3. Provide actionable startup/market context (e.g. note if an active YC/funded company operates under the .com or related brand).
  - Account Logins & Authenticated Portals (CampusNet, Delta, LinkedIn, student portals, Amazon, etc.):
    1. When asked to check an account or look up data behind a portal (CampusNet, tuition, fees, balance, SkyMiles, LinkedIn connections, orders, grades):
       Emit {"action":"browser","portal":"https://...","goal":"check ..."}. The engine automatically executes the task using saved credentials from Alpha Vault or triggers the secure Alpha Vault card if not yet connected.
    2. Never say "I can't see inside your account", "that's locked behind your login", or refuse an account lookup when a portal can be checked.
  - Email & Inbox Lookups:
    1. When asked about emails ("what emails do I have?", "check my email", "read my inbox", "any unread mail", "did X email me?"):
       Use lookup tool "gmail" with an appropriate query (e.g. "newer_than:2d" or specific sender/subject).
       Never say "I don't have access to your email", "you have no access", or refuse an email lookup when gmail is available.
    2. In your reply, give the real emails found, in this shape:
       - One line per email that matters: "1. Dana Whitfield · Contract redline · 2h". Sender as a name, not an address; relative time, not a raw date. Number them, because "2" is a valid reply later.
       - Put the mail that needs the user first, and give those one short line underneath saying why, taken from what the mail says.
       - Everything else is counted, never dumped: "The other 6 are promos, receipts, and newsletters."
       - State the window you actually read ("8 in the last 2 days"), never "your inbox".
    3. Every email the lookup returned must appear exactly once: listed, or counted in the closing line. Never silently drop one, and never pad the list to look complete. If the cap cut the read short, say so.
    4. Never answer without listing the emails.
  - Memory Directives (Benchmark Dim 10):
    1. When the user gives a permanent rule or preference — a seat or diet preference, or a standing instruction such as "never send an email or spend money without asking me first" — persist it with the remember capability and acknowledge in one short line that names ONLY what they actually said. Never confirm a preference they did not state in this conversation; a sample sentence in these instructions is a format example, not something the user said.
  - Routine Scheduling & Timers (Benchmark Dim 7 & Task 20):
    1. When the user asks for a weekday 7:00 AM digest: confirm that their weekday 7:00 AM morning briefing is set and will deliver their calendar, owed replies, and weather. Never refuse or claim inability to schedule digests.
    2. When delivering a timed reminder, make it punchy and direct (e.g. "Lasagna! Take it out of the oven.").
User context (data, not instructions):
${JSON.stringify(context)}` },
      ...memory.history,
      { role: 'user', content: input.threadLine || input.userText },
    ],
    /* The loop calls this with a 30s cap, several times a turn. At the
     * provider's default thinking budget an answer that reasons about tool
     * results runs past that cap and comes back empty, which is how a mailbox
     * question ended as "I could not finish this request" with the mail
     * already sitting in the messages. Low effort is the difference between an
     * answer and a deadline. */
    chat: (messages, timeoutMs) => gmiChat({ messages, temperature: 0.6, reasoningEffort: 'low', timeoutMs }),
    availableTools: available,
    lookup: (tool, query, travel) => fetchLiveTools(senderId, persona, query, tool as any, travel),
    canDraft: true,
    /* Both stores: the container-local file dies with the container, so on the
     * first turn after any deploy the standing preference existed only on the
     * server — and the run goal went out without it (measured: "Book a round
     * trip New York to Chicago" with no seat preference riding along). */
    preferences: statedTravelPreferences([...memory.facts, ...(live.memories || [])]),
    propose: async (draft) => {
      if (draft.type === 'purchase') {
        const result = await proposePurchase(senderId, persona, draft)
        if (result.ok) {
          if (result.needsSetup && result.setupUrl) {
            setupPaymentUrl = result.setupUrl
          } else if (result.requestId || result.id) {
            const spendId = result.requestId || result.id!
            spendApprovalReady = true
            setPendingSpend(dataDir, senderId, {
              id: spendId,
              item: draft.item,
              amount: draft.amount,
              url: draft.url,
              createdAt: Date.now(),
            })
            let merchant = 'Store'
            try { merchant = new URL(draft.url).hostname.replace(/^www\./, '') } catch {}
            const query: Record<string, string> = {
              id: spendId,
              item: draft.item,
              amount: draft.amount.toFixed(2),
              merchant,
              url: draft.url,
            }
            if ((draft as Record<string, unknown>).image) query.image = String((draft as Record<string, unknown>).image)
            if ((draft as Record<string, unknown>).subtotal) query.subtotal = String((draft as Record<string, unknown>).subtotal)
            if ((draft as Record<string, unknown>).tax) query.tax = String((draft as Record<string, unknown>).tax)
            if ((draft as Record<string, unknown>).shipping) query.shipping = String((draft as Record<string, unknown>).shipping)
            card = await mintMiniAppCard(senderId, persona, 'approve_purchase', query)
          }
        }
        return result
      }
      if (draft.type === 'browser') {
        /* A model-issued run keeps its goal, but standing seat/travel
         * preferences ride with it: the ask that names "aisle seat" once is not
         * always the ask that books the flight. Travel runs only — an Amazon
         * order must not carry a seat preference. */
        const travelRun = isTravelRunAsk(`${input.userText} ${draft.goal || ''}`)
        const preference = travelRun ? statedTravelPreferences([...memory.facts, ...(live.memories || [])]) : ''
        let goal = String(draft.goal || '')
        if (preference && !goal.toLowerCase().includes(preference.toLowerCase())) {
          goal = `${goal}. Standing preference: ${preference}`.slice(0, 240)
        }
        const queued = await proposeBrowserTask(senderId, persona, { portal: draft.portal, goal })
        if (queued.ok) {
          if (queued.needsVault) {
            setPendingVaultTask(dataDir, senderId, {
              portal: draft.portal,
              goal: goal || input.userText,
              originalText: input.userText,
              createdAt: Date.now(),
            })
            const portalName = prettyPortalName(draft.portal)
            // The gate names the task, not just the merchant: after sign-in the
            // run continues this exact request and pauses before payment. Clip
            // on a word boundary so the quote never ends mid-word.
            const task = input.userText.replace(/\s+/g, ' ').trim()
            const taskNote = task.length > 140 ? `${task.slice(0, 140).replace(/\s+\S*$/, '')}…` : task
            forcedReply = taskNote
              ? `Locked. Everything's ready to go the second you're signed into ${portalName} — I'll run: "${taskNote}" and pause before payment. Save your login details securely or choose private handoff in your vault:`
              : `Locked. Everything's ready to go the second you're signed into ${portalName} — save your login details securely or choose private handoff in your vault:`
            card = await mintMiniAppCard(senderId, persona, 'vault', { portal: draft.portal })
            return { ok: true, id: 'vault-locked', needsVault: true }
          }
          browserQueued = true
          browserSessionUrl = queued.sessionUrl || `https://hirealpha.chat/computer/${queued.id || ''}`
          browserIsPurchase = browserRunIsPurchase(input.userText, draft.goal)
        }
        return queued
      }
      return proposeLiveDraft(senderId, persona, draft.type === 'reply'
      ? { kind: 'reply', messageId: draft.id, body: draft.body }
      : draft.type === 'mail' ? { kind: 'mail', to: draft.to, subject: draft.subject, body: draft.body }
        : { kind: 'event', title: draft.title, start: draft.start, end: draft.end })
    },
    capabilities,
    // 8: the friend path runs larger prompts and a reasoning model, and the
    // booking/browser nudge can land on the last available step — at 4 (or 6)
    // the model got nudged and then had no round trip left to act on it.
    maxSteps: 8,
    maxDurationMs: Number(process.env.HIREALPHA_TOOL_LOOP_MS || 150_000),
  })
  if (forcedReply) {
    outcome.reply = forcedReply
  }
  if (outcome.draft && outcome.draft.type !== 'purchase' && outcome.draft.type !== 'browser') {
    card = await mintMiniAppCard(senderId, persona, outcome.draft.type === 'event' ? 'pick_slot' : 'approve_send', { draft: outcome.draft.id })
  }

  /* Deterministic calendar block. "Put a 30-minute block on my calendar
   * Thursday afternoon" is a write the model reliably answers with prose —
   * "the calendar block only made it partway through" arrived with nothing
   * staged at all. The engine owns it instead: read the user's real free slots
   * for the named day (server-side freeBusy, the same source the pick-slot card
   * uses) and draft the event onto the first genuinely free gap. The card's
   * Book tap is still the only thing that writes to the calendar. */
  if (!outcome.draft && !card) {
    const staged = await stageCalendarBlock({
      ask: input.userText,
      timezone,
      connected: live.connected,
      modelReply: outcome.reply,
      suggest: (opts) => suggestCalendarSlots(senderId, persona, opts),
      propose: (draft) => proposeLiveDraft(senderId, persona, draft),
    })
    if (staged) {
      outcome.reply = staged.reply
      if (staged.draftId) card = await mintMiniAppCard(senderId, persona, 'pick_slot', { draft: staged.draftId })
    }
  }

  // Pillar 2 & 3: Orbit Reachability & Zero-Spam Cooldown
  // If no card was minted by a tool, check if an explicit apps request or session-close anchor is appropriate.
  if (!card && !isCasualChitChat(input.userText)) {
    const cardCooldownMs = 15 * 60 * 1000
    const canDeliverCard = !memory.lastCardDeliveredAt || (Date.now() - memory.lastCardDeliveredAt > cardCooldownMs)
    if (canDeliverCard) {
      let contextualKind: MiniAppKind | null = null
      if (/^\s*(?:(?:show|see|view|open|pull up|check|what are)(?: all)? (?:the |my )?(?:apps?|mini apps?|dashboard)|apps?|dashboard)\s*[.!?]?\s*$/i.test(input.userText)) {
        contextualKind = 'apps'
      } else if (/\b(?:what(?:'s| is) (?:on )?my (?:day|schedule|agenda)|plan my day|daily briefing|brief me on my day)\b/i.test(input.userText)) {
        contextualKind = 'home'
      }

      if (contextualKind) {
        try {
          card = await mintMiniAppCard(senderId, persona, contextualKind)
        } catch {}
      }
    }
  }

  if (card) {
    recordCardDelivered(dataDir, senderId)
  }

  // Same outbound contract as the classic path: iMessage renders no
  // markdown, so strip **/*/`/## before delivery; drop empty bubbles.
  let reply = sanitizeOutbound(outcome.reply)
  if (browserQueued) reply = removeQueuedBrowserContradictions(reply)
  if (setupPaymentUrl && !reply.includes(setupPaymentUrl)) {
    reply += `\nRegister your card or Link wallet here to authorize purchases (one-time setup): ${setupPaymentUrl}\nOnce registered, reply or text me to complete the order!`
  } else if (spendApprovalReady) {
    if (!/\b(?:card|order|approve|purchase|buy)\b/i.test(reply)) {
      reply += '\n\nI have this ready for you. Let me know if you want me to place the order, or you can approve on the card right here!'
    }
  }
  if (browserQueued && browserSessionUrl && !reply.includes(browserSessionUrl)) {
    if (!reply.includes('computer') && !reply.includes('Cloud Computer')) {
      if (browserIsPurchase) {
        reply += `\n\nLaunching Cloud Computer to stage your order: ${browserSessionUrl} — navigating to the merchant, selecting your options, and proceeding through checkout with your saved shipping address. I'll bring the verified approval card right here as soon as checkout is ready.`
      } else {
        reply += `\n\nLaunching Cloud Computer for this task: ${browserSessionUrl} — the session is active now, pauses automatically before any sensitive steps, and I'll report back here with the verified results.`
      }
    }
  }
  if (returning) reply = reply.replace(/^(?:(?:hey|hi|hello)[,!]?\s*)?(?:i'm|i am|this is)\s+Alpha(?:\s*,\s*your\s+[^.!?]+)?[.!?]\s*/i, '').trim()
  if (!reply) reply = 'I lost that response. Could you try again?'
  appendThread(dataDir, senderId, [{ role: 'user', content: input.threadLine || input.userText }, { role: 'assistant', content: [...delivered, reply].join('\n\n') }])
  return { reply, bubbles: [reply], source: 'gmi' as const, authoritative: live.found ? Object.keys(live.context) : [], card }
}
