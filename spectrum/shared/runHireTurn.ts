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
import { autoLogNutrition, fetchLiveProfile, fetchLiveTools, fetchMiniRun, formatHireContext, formatHireMemories, persistLiveFacts, touchInbound } from './liveContext'
import {
  looksLikeReminder,
  parseReminderIntent,
  createReminder,
  listReminders,
  localTimeToUtc,
} from './reminders'
import {
  DIGEST_MARKER,
  detectMiniAppRequest,
  looksLikeDigestIntent,
  mintMiniAppCard,
  type MiniAppCard,
} from './miniApps'

export function splitBubbles(text: string): string[] {
  const cleaned = text.replace(/\r/g, '').trim()
  if (!cleaned) return ['…']
  // One inbound text should produce one text bubble. Splitting paragraphs into
  // separate sends makes a single answer look like duplicate replies.
  return [cleaned]
}

/** Drop model chain-of-thought that occasionally leaks into the reply text. */
function stripReasoning(text: string): string {
  const paras = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  const REASON = /(?:the (?:user|instructions)|instructions say|tool result|in context|connected as a tool|I (?:should|need to|have|will|am going|want to|can check the))|^Let me|^Wait,?|^First,?|^OK[,:]|^Alright[,:]|^So /i
  let firstReal = 0
  while (firstReal < paras.length) {
    const p = paras[firstReal]
    if (!p || !REASON.test(p)) break
    firstReal++
  }
  const kept = paras.slice(firstReal)
  return kept.length ? kept.join('\n\n') : text.trim()
}

function wantsLiveData(text: string) {
  return /\b(e-?mails?|inbox|mail|gmail|unread|calendar|meeting|meetings|schedule|agenda|tomorrow|today|slack|notion|linear|github|drive|spotify|dinner|restaurant|tonight|maps|place|places|ticket|backlog|triage|deck|wiki|look up|search)\b/i.test(
    text,
  )
}

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

function looksLikeNutritionLog(text: string) {
  return /\b(i ate|i had|log|track|meal|breakfast|lunch|dinner|snack|food)\b/i.test(text)
}

const LIVE_MINI = new Set(['pick_night', 'standup_paste', 'kill_keep_park'])

const TOOL_HINT: Record<string, string> = {
  gmail: 'check my gmail inbox',
  calendar: 'what is on my calendar today',
  maps: 'quiet restaurant nearby tonight',
  slack: 'check slack',
  linear: 'linear issues backlog',
  notion: 'search notion docs',
  drive: 'list drive files',
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
    const pending = items.filter((r) => r.status === 'pending')
    if (!pending.length) return "You don't have any reminders lined up right now."
    const lines = pending.map((r) => {
      const when = formatLocalAtSafe(r.scheduledAt, input.timezone)
      const rep = r.recurrence !== 'once' ? ` (${r.recurrence})` : ''
      const label = r.text.replace(/^\[(poke|digest)\]/, '').trim()
      return `- ${when}${rep}: ${label}`
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
  const isFirst = history.length === 0
  const live = await fetchLiveProfile(input.senderId, agent.id)
  const timezone = live.context?.timezone || live.timezone || 'America/Los_Angeles'

  if (live.hired) {
    void touchInbound(input.senderId, agent.id)
  }

  if (live.hired && looksLikeReminder(input.userText)) {
    const handled = await handleReminderMessage({
      phone: input.senderId,
      persona: agent.id,
      userText: input.userText,
      timezone,
    })
    if (handled) {
      appendThread(input.dataDir, input.senderId, [
        { role: 'user', content: input.userText },
        { role: 'assistant', content: handled },
      ])
      return { reply: handled, bubbles: splitBubbles(handled), source: 'gmi', authoritative: [], card: null }
    }
  }

  let toolResults =
    live.found && live.hired && wantsLiveData(input.userText)
      ? await fetchLiveTools(input.senderId, agent.id, input.userText)
      : []
  if (
    live.found &&
    live.hired &&
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

  if (live.found && live.hired && !toolResults.length && maybeToolIntent(input.userText)) {
    const intent = await classifyFreeLookup(input.userText)
    if (
      intent &&
      intent.tool !== 'none' &&
      (intent.query || input.userText)
    ) {
      toolResults = await fetchLiveTools(
        input.senderId,
        agent.id,
        intent.query || input.userText,
        intent.tool,
      )
    }
  }

  const setupDone = live.context && String(live.context.setup_done) === 'true'
  const miniApp = live.hired
    ? isFirst && !setupDone
      ? { kind: 'menu' as const }
      : detectMiniAppRequest(input.userText, agent.id)
    : null

  const extras: string[] = []
  if (!live.found) {
    extras.push(
      'This sender is not linked to a HireAlpha account yet. If they ask about email, calendar, or personal setup, tell them to sign in at hirealpha.chat/app with the same phone they are texting from.',
    )
  } else if (!live.hired) {
    extras.push(
      `They have a HireAlpha account (${live.email || 'signed in'}) but have not hired this person yet. Point them to hirealpha.chat/app to hire ${agent.name}.`,
    )
  } else {
    if (live.name) {
      extras.push(
        `This person's name is ${live.name}. Use it naturally. Address them by name when it fits.`,
      )
    }
    const ctx = formatHireContext(live.context)
    if (ctx) extras.push(ctx)
    const remembered = formatHireMemories(live.memories)
    if (remembered) extras.push(remembered)
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
        `Nutrition was automatically logged as ${nutrition.guess || input.userText} (${nutrition.calories || 0} calories, ${nutrition.protein || 0}g protein, ${nutrition.carbs || 0}g carbs, ${nutrition.fat || 0}g fat). Confirm the log briefly in the reply; do not ask them to log it again.`,
      )
    } else if (nutrition?.error) {
      extras.push('Nutrition auto-log failed. Do not claim the meal was logged; offer the Nutrition card instead.')
    }
  }
  if (toolResults.length) {
    extras.push(
      `Live tool results (ground truth, use these, do not invent):\n${toolResults.join('\n\n')}\n\nWhen email results are present: give a short overview of the batch (how many, themes), then call out the top 2-3 that matter most with a one-line reason each. Do not fixate on a single email.`,
    )
  }
  if (miniApp) {
    extras.push(
      miniApp.kind === 'menu'
        ? 'A setup mini-app card is being delivered with your first reply. Introduce yourself briefly, then point them at the card and invite them to pick a feature. Keep your text short. The card carries the options.'
        : LIVE_MINI.has(miniApp.kind)
          ? `A mini-app card for "${miniApp.kind}" is also being delivered. Put the live mini-app result in your text. The card is extra.`
          : `A mini-app card for "${miniApp.kind}" is being delivered with your reply. Keep your text short and offer the card in one line.`,
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

  try {
    const firstHint = isFirst
      ? '\nThis is their first message to you. Introduce yourself briefly in character, then answer.'
      : ''
    reply = await gmiChat({
      temperature: agent.temperature,
      maxTokens: toolResults.length ? Math.max(agent.maxTokens, 700) : Math.max(agent.maxTokens, 320),
      messages: [
        { role: 'system', content: system + firstHint },
        ...history,
        { role: 'user', content: input.userText },
      ],
    })
  } catch (err) {
    console.warn(`[${agent.id}] GMI fallback:`, err)
    if (isFirst) {
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

  appendThread(input.dataDir, input.senderId, [
    { role: 'user', content: input.userText },
    { role: 'assistant', content: reply },
  ])

  const authoritative = live.found ? Object.keys(live.context) : []
  const finalReply = stripReasoning(reply)
  const card = miniApp
    ? await mintMiniAppCard(input.senderId, agent.id, miniApp.kind, miniApp.query)
    : null

  return { reply: finalReply, bubbles: splitBubbles(finalReply), source, authoritative, card }
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
