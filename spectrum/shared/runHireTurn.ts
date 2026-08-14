import {
  getAgent,
  buildSystemPrompt,
  type AgentId,
} from '../../src/agents'
import { runAgentLocally } from '../../src/agents/runtime'
import { skillsPromptBlock } from './skills'
import { gmiChat } from './gmi'
import { appendThread, loadMemory, upsertFacts, pruneExpiredFacts, setSummary, trimHistory, MAX_RAW, type ThreadMemory } from './memory'
import { extractFacts, summarizeOld } from './memoryMaintain'
import { fetchLiveProfile, fetchLiveTools, formatHireContext } from './liveContext'
import {
  looksLikeReminder,
  parseReminderIntent,
  createReminder,
  listReminders,
  localTimeToUtc,
} from './reminders'

export function splitBubbles(text: string): string[] {
  const cleaned = text.replace(/\r/g, '').trim()
  if (!cleaned) return ['…']
  const parts = cleaned
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length <= 1) {
    if (cleaned.length > 220) {
      const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned]
      const chunks: string[] = []
      let buf = ''
      for (const s of sentences) {
        const next = (buf + s).trim()
        if (next.length > 180 && buf) {
          chunks.push(buf.trim())
          buf = s
        } else {
          buf = next
        }
      }
      if (buf.trim()) chunks.push(buf.trim())
      return chunks.slice(0, 3)
    }
    return [cleaned]
  }
  return parts.slice(0, 3)
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
  return /\b(e-?mails?|inbox|gmail|unread|calendar|meeting|meetings|schedule|agenda|tomorrow|today|slack|notion|linear|github|drive|spotify)\b/i.test(
    text,
  )
}

function buildMemoryBlock(mem: ThreadMemory): string {
  const facts = mem.facts.length
    ? mem.facts.map((f) => `${f.key}: ${f.value}`).join('\n')
    : ''
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
    const ok = await createReminder({
      phone: input.phone,
      persona: input.persona,
      text: intent.text,
      scheduledAt: utc,
      recurrence: intent.recurrence,
      timezone: input.timezone,
    })
    if (!ok) return "I couldn't save that reminder right now. Try again in a sec?"
    const when = intent.recurrence === 'once' ? '' : ` ${intent.recurrence}`
    return `Got it — I'll remind you${when} at ${intent.localTime.slice(0, 16).replace('T', ' ')} (${input.timezone}): "${intent.text}".`
  }
  if (intent.action === 'list') {
    const items = await listReminders(input.phone, input.persona)
    const pending = items.filter((r) => r.status === 'pending')
    if (!pending.length) return "You don't have any reminders lined up right now."
    const lines = pending.map((r) => {
      const when = formatLocalAtSafe(r.scheduledAt, input.timezone)
      const rep = r.recurrence !== 'once' ? ` (${r.recurrence})` : ''
      return `- ${when}${rep}: ${r.text}`
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
}> {
  const agent = getAgent(input.agentId)
  const mem = loadMemory(input.dataDir, input.senderId)
  const history = mem.history
  const live = await fetchLiveProfile(input.senderId, agent.id)
  const timezone = live.context?.timezone || live.timezone || 'America/Los_Angeles'

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
      return { reply: handled, bubbles: splitBubbles(handled), source: 'gmi', authoritative: [] }
    }
  }

  const toolResults =
    live.found && live.hired && wantsLiveData(input.userText)
      ? await fetchLiveTools(input.senderId, agent.id, input.userText)
      : []

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
        `This person's name is ${live.name}. Use it naturally — address them by name when it fits.`,
      )
    }
    const ctx = formatHireContext(live.context)
    if (ctx) extras.push(ctx)
  }
  if (toolResults.length) {
    extras.push(
      `Live tool results (ground truth, use these, do not invent):\n${toolResults.join('\n\n')}\n\nWhen email results are present: give a short overview of the batch (how many, themes), then call out the top 2-3 that matter most with a one-line reason each. Do not fixate on a single email.`,
    )
  } else if (live.hired && wantsLiveData(input.userText)) {
    extras.push(
      'They asked about a connected app, but no live data came back. If the tool is not in the connected list, tell them to open this hire at hirealpha.chat/app and tap Connect. Do not invent inbox or calendar contents.',
    )
  }

  const memoryBlock = buildMemoryBlock(mem)

  const system = [
    buildSystemPrompt(agent, live.connected),
    skillsPromptBlock(agent.id),
    memoryBlock,
    extras.join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n\n')

  let reply: string
  let source: 'gmi' | 'local' = 'gmi'
  const isFirst = history.length === 0

  try {
    const firstHint = isFirst
      ? '\nThis is their first message to you. Introduce yourself briefly in character, then answer.'
      : ''
    reply = await gmiChat({
      temperature: agent.temperature,
      maxTokens: toolResults.length ? Math.max(agent.maxTokens, 700) : agent.maxTokens,
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
          "Hey — I'm Alpha, your friend in texts. I'm here. What's going on?",
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

  return { reply: finalReply, bubbles: splitBubbles(finalReply), source, authoritative }
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
    if (facts.length) upsertFacts(input.dataDir, input.senderId, facts)

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
