/**
 * The dispatcher: one table that routes any message to a capability.
 *
 * Four tiers, in the middleman model:
 *   1 DO      — Alpha executes itself (log, recall, sweep, dump, …)
 *   2 CONNECT — Alpha drives connected tools (mail, calendar, drive)
 *   3 BUILD   — no capability exists, so the workshop makes one
 *   4 DELEGATE — the long tail is other humans; Alpha drafts the outreach
 *
 * The manifest is the single source of truth: it routes messages, powers the
 * `/` command menu, and answers "what can you do". Unknown task asks fall
 * through to delegate — never a shrug.
 */
import {
  handleBillguard,
  handleBrainDump,
  handleDebrief,
  handleKeepMeHonest,
  handleRecall,
  handleSnapLog,
  handleSweep,
  handleToolbox,
  looksLikeBillguard,
  looksLikeBrainDump,
  looksLikeDebrief,
  looksLikeKeepMeHonest,
  looksLikeRecall,
  looksLikeSnapLog,
  looksLikeSweep,
  looksLikeToolbox,
  looksLikeTravelMode,
} from './smartFeatures'

export type DispatchContext = {
  text: string
  timezone: string
  memories: string[]
  context: Record<string, string>
  contacts: Array<{ name: string; phone?: string }>
  userName?: string | null
}

export type Capability = {
  name: string
  label: string
  example: string
  detect: (text: string) => boolean
  run: (ctx: DispatchContext, arg: string) => string
}

/** Contact-picker keywords that should never be treated as a delegate task. */
const NOT_TASKS =
  /\b(?:sure|it|that|this|them|him|her|dinner|lunch|reminder|alarm|reservation|love|war|fun|noise|move|wish|sense|smile|laugh|wall|difference|mistake|decision|my day|joke|poem)\b/i

const TASK_VERB =
  /\b(?:book|order|cancel|buy|get|find|schedule|arrange|set up|reserve|hire|fix|replace|renew|refill|deliver|pick up|call|email)\b/i

/** Tier 4: a task-shaped ask the other capabilities can't take. */
export function looksLikeTaskAsk(text: string): boolean {
  const ask = /\b(?:can|could|will|would)\s+(?:you|someone|we)\b|\bplease\b|^\s*(?:book|order|cancel|buy|get|find|schedule|arrange|set up|reserve|renew|refill)\b|\b(?:for me|for us)\b/i.test(
    text,
  )
  return ask && TASK_VERB.test(text) && !NOT_TASKS.test(text)
}

/** Pick the best contact for a task: name match wins; no guess on no match. */
export function pickContact(ask: string, contacts: DispatchContext['contacts']): DispatchContext['contacts'][number] | null {
  if (!contacts.length) return null
  const words = new Set((ask.toLowerCase().match(/[a-z][a-z'-]+/g) || []))
  const named = contacts.find((c) =>
    String(c.name || '')
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.length > 2 && words.has(w)),
  )
  return named || null
}

/** The Tier 4 draft: Alpha writes the outreach the user one-tap sends. */
export function handleDelegate(ask: string, contacts: DispatchContext['contacts'], userName?: string | null): string {
  const contact = pickContact(ask, contacts)
  if (!contact) {
    return `I can get that moving, but I don't have a contact on file for it. Tell me who handles this (name and number) and I will draft the message.`
  }
  const cleanAsk = ask.replace(/^(?:can|could|will|would)\s+you\s+(?:please\s+)?/i, '').replace(/\bfor me\b/gi, '').trim()
  const first = String(contact.name || '').split(/\s+/)[0] || 'there'
  const sign = userName ? ` Thanks! — ${userName}` : ' Thanks!'
  const draft = `Hi ${first}, quick one: ${cleanAsk.replace(/\?$/, '')}. Can you help with that?${sign}`
  const digits = String(contact.phone || '').replace(/[^\d+]/g, '')
  const emailAsk = /\bemail\b/i.test(ask)
  const link = emailAsk && contact.email
    ? `mailto:${contact.email}?subject=${encodeURIComponent('Quick request')}&body=${encodeURIComponent(draft)}`
    : digits
      ? `sms:${digits}&body=${encodeURIComponent(draft)}`
      : ''
  return [
    `On it — the fastest path is ${contact.name}. Draft from you:`,
    `"${draft}"`,
    link ? `Send it in one tap: ${link}` : 'Their number is not on file — reply with it and I will finish the draft.',
  ].join('\n')
}

/** The manifest: Tier 1 capabilities. Order is routing priority. */
export const CAPABILITIES: Capability[] = [
  {
    name: 'recall',
    label: 'Recall',
    example: 'recall what I promised maya',
    detect: looksLikeRecall,
    run: (ctx, arg) => handleRecall(arg || ctx.text, { loops: ctx.memories, decisions: ctx.memories, meetings: ctx.memories }),
  },
  {
    name: 'debrief',
    label: 'Debrief',
    example: 'debrief the call',
    detect: looksLikeDebrief,
    run: (ctx) => handleDebrief(ctx.context?.next_meeting || 'the call'),
  },
  {
    name: 'sweep',
    label: 'Sweep',
    example: 'sweep',
    detect: looksLikeSweep,
    run: (ctx) => handleSweep((ctx.context?.drafts || '').split(',').filter(Boolean).length, (ctx.context?.drafts || '').split(',').filter(Boolean)),
  },
  {
    name: 'dump',
    label: 'Brain Dump',
    example: 'dump: call the dentist, buy milk',
    detect: looksLikeBrainDump,
    run: (ctx) => handleBrainDump(ctx.text, ctx.timezone),
  },
  {
    name: 'snap',
    label: 'Snap Log',
    example: 'snap log this meal',
    detect: looksLikeSnapLog,
    run: () => handleSnapLog(),
  },
  {
    name: 'bills',
    label: 'Billguard',
    example: 'how much do I pay for netflix',
    detect: looksLikeBillguard,
    run: (ctx) =>
      handleBillguard(
        (ctx.context?.subscriptions || '')
          .split('|')
          .filter(Boolean)
          .map((s) => ({ name: s.trim() })),
      ),
  },
  {
    name: 'travel',
    label: 'Travel Mode',
    example: 'travel mode to tokyo',
    detect: looksLikeTravelMode,
    run: (ctx) => handleTravelMode(ctx.text.replace(/.*\b(?:to|by|for)\s+([A-Za-z][A-Za-z .'-]{1,30}).*/, '$1')),
  },
  {
    name: 'honest',
    label: 'Keep Me Honest',
    example: 'keep me honest at 7pm to run',
    detect: looksLikeKeepMeHonest,
    run: (ctx) => handleKeepMeHonest(ctx.text, ctx.timezone),
  },
  {
    name: 'tools',
    label: 'Toolbox',
    example: 'show me my tools',
    detect: looksLikeToolbox,
    run: (ctx) =>
      handleToolbox(
        (ctx.context?.toolbox || '')
          .split('|')
          .filter(Boolean)
          .map((b) => {
            const [t, u] = b.split('§')
            return { title: (t || '').trim(), url: (u || '').trim() }
          }),
      ),
  },
]

export function capabilityByName(name: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.name === name)
}

/* ---- Slash commands ---- */

export function parseSlash(text: string): { name: string; arg: string } | null {
  const m = text.match(/^\s*\/([a-z][a-z-]*)(?:\s+([\s\S]+))?$/i)
  if (!m) return null
  return { name: m[1].toLowerCase(), arg: (m[2] || '').trim() }
}

/** `/` or an unknown command returns the menu. */
export function slashMenu(): string {
  const lines = CAPABILITIES.map((c) => `/${c.name} — ${c.example}`).join('\n')
  return `Commands:\n${lines}\n/delegate {ask} — draft outreach to the right person\nPlain text works too — commands are just shortcuts.`
}

/** Run a slash command; null when the text is not a slash command. */
export function dispatchSlash(text: string, ctx: DispatchContext): string | null {
  if (/^\s*\/\s*$/.test(text)) return slashMenu()
  const cmd = parseSlash(text)
  if (!cmd) return null
  if (cmd.name === 'help' || cmd.name === 'commands') return slashMenu()
  if (cmd.name === 'delegate') return handleDelegate(cmd.arg || 'your request', ctx.contacts, ctx.userName)
  const cap = capabilityByName(cmd.name)
  if (!cap) return slashMenu()
  return cap.run(ctx, cmd.arg)
}

/** Full dispatch: slash first, then manifest routing, then Tier 4 fallback. */
export function dispatch(ctx: DispatchContext): string | null {
  if (ctx.text.trim().startsWith('/')) return dispatchSlash(ctx.text, ctx)
  if (/\bwhat can you do\b|\byour (?:capabilities|commands|features)\b|\bhow do i use you\b/i.test(ctx.text)) {
    return `I can ${CAPABILITIES.map((c) => c.label.toLowerCase()).join(', ')}. Try "/${CAPABILITIES[0].name}" or just say it in plain words.`
  }
  for (const cap of CAPABILITIES) {
    if (cap.detect(ctx.text)) return cap.run(ctx, ctx.text)
  }
  if (looksLikeTaskAsk(ctx.text)) return handleDelegate(ctx.text, ctx.contacts, ctx.userName)
  return null
}