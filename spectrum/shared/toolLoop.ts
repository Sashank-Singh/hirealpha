export const LIVE_TOOLS = ['maps', 'web', 'gmail', 'calendar', 'drive'] as const
export type LiveTool = (typeof LIVE_TOOLS)[number]

export type DraftCall =
  | { type: 'mail'; to: string; subject: string; body: string }
  | { type: 'reply'; id: string; body: string }
  | { type: 'event'; title: string; start: string; end: string }

export type PersonHit = { name: string; phone?: string; email?: string }

export const TOOL_LOOP_INSTRUCTIONS = `You can send mail, create calendar events, and follow up. Do not mime those. If a draft card is already attached, tell them to tap Send, Book, or Text. Never say you already sent, booked, or texted.

If they asked you to prep for a person or meeting, the Prep bundle is already stitched: calendar, People notes, and the mail thread. Write that as one prep. Do not ask them to pull pieces. If a Send card is attached, tell them to tap Send.

If they asked you to run the week, the weekly review is already written from logs. Put it in the text. Do not ask them to fill the card. If a Send or Spending card is attached, that is public or money: tell them to tap. Never send or spend on your own.

Never diagnose. Never give legal advice. Never move money. If they asked for those, refuse in one text. Do not attach Send.
Never replace them in grief, a live negotiation, or taste you have not been taught. Listen. Prep. Ask. Do not close. Do not invent who they are.

If you still need a lookup that is not in Life right now, output exactly one line and stop:
TOOL maps <query>
TOOL web <query>
TOOL gmail <query>
TOOL calendar <query>
TOOL drive <query>

When a maps result block is present, recommend one place from it in your own voice with a reason (walkable, quiet, fits the ask), name one alternate, and include the OSM link for your pick. If the result says a city or area is needed, ask one short question like "which city?" instead of guessing. Never invent places that are not in the result.

If no card is attached yet and they want mail or a calendar event, output one line:
DRAFT_MAIL to=email@x.com | subject=Subject | body=The mail on one line
DRAFT_REPLY id=<gmail id from the mail lines> | body=The reply on one line
DRAFT_EVENT title=Title | start=2026-08-21T15:00 | end=2026-08-21T15:30`

const TOOL_RE = /\bTOOL\s+(maps|web|gmail|calendar|drive)\s+(.+?)(?:\n|$)/i
const DRAFT_MAIL_RE = /\bDRAFT_MAIL\s+to=([^|]+)\|\s*subject=([^|]+)\|\s*body=(.+)/i
const DRAFT_REPLY_RE = /\bDRAFT_REPLY\s+id=([^|]+)\|\s*body=(.+)/i
const DRAFT_EVENT_RE = /\bDRAFT_EVENT\s+title=([^|]+)\|\s*start=([^|\n]+)(?:\|\s*end=([^\n]+))?/i
const DIRECTIVE_RE = /^\s*(?:TOOL\s+(?:maps|web|gmail|calendar|drive)|DRAFT_(?:MAIL|REPLY|EVENT))\b.*$/gim

export function looksLikeMailWrite(text: string) {
  const t = String(text || '')
  return (
    /\b(send|draft|write|fire)\b.{0,48}\b(e-?mail|mail|gmail|note)\b/i.test(t) ||
    /\b(e-?mail|mail)\s+(?:to|them|her|him)\b/i.test(t) ||
    /\breply (?:to|all)\b/i.test(t) ||
    /\b(?:send|email)\s+[A-Za-z][\w'.-]{1,40}\b/i.test(t)
  )
}

export function looksLikeEventWrite(text: string) {
  const t = String(text || '')
  return (
    /\b(add|put|create|book|hold|schedule|make)\b.{0,48}\b(calendar|event|meeting|call|slot|hold)\b/i.test(t) ||
    /\bon (?:my )?calendar\b/i.test(t) ||
    /\bbook (?:me |a )?(?:slot|time|meeting|call)\b/i.test(t)
  )
}

export function looksLikeFollowUp(text: string) {
  const t = String(text || '')
  return (
    /\bfollow(?:ing)? up\b/i.test(t) ||
    /\breach out\b/i.test(t) ||
    /\bcheck in with\b/i.test(t) ||
    /\breconnect with\b/i.test(t) ||
    /\b(?:ping|text|sms)\s+[A-Za-z][\w'.-]{1,40}\b/i.test(t)
  )
}

export function looksLikePrep(text: string) {
  return /\bprep(?: me)?(?: for)?\b|\bget me ready\b|\bbrief me (?:on|for)\b|\bread me in (?:on|for)\b/i.test(
    text,
  )
}

export function prepTarget(text: string): string | null {
  const m = String(text || '').match(
    /\b(?:prep(?: me)?(?: for)?|get me ready for|brief me (?:on|for)|read me in (?:on|for))\s+(?:the |my |our |this )?(.+?)$/i,
  )
  if (!m?.[1]) return null
  const cleaned = m[1]
    .replace(/\b(meeting|call|1-?1|sync|interview|today|tomorrow)\b/gi, ' ')
    .replace(/\bwith\b/gi, ' ')
    .replace(/[.?!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || m[1].replace(/[.?!]+$/g, '').trim()
}

export function looksLikeWeekRun(text: string) {
  const t = String(text || '')
  if (/\b(?:open|show|pull up|bring back)\b.{0,24}\bweekly review\b/i.test(t)) return false
  return (
    /\brun (?:my |the )?week\b/i.test(t) ||
    /\bhandle (?:my |the )?week\b/i.test(t) ||
    /\bdo (?:my )?week(?: for me)?\b/i.test(t) ||
    /\bhow was (?:my )?week\b/i.test(t) ||
    /\bwhat (?:got done|slipped) this week\b/i.test(t) ||
    /\breview (?:my )?week\b/i.test(t) ||
    /\bend of (?:the )?week\b/i.test(t)
  )
}

export type HardStop = 'legal' | 'health' | 'money'

export function looksLikeMoneyMovement(text: string) {
  const t = String(text || '')
  if (/\bi (?:spent|paid|got charged)\b/i.test(t) && !/\b(venmo|zelle|paypal|wire|send money)\b/i.test(t)) {
    return false
  }
  return (
    (/\b(venmo|zelle|paypal|cash app|apple cash|wise)\b/i.test(t) &&
      /\$\s*\d|\bpay\b|\bsend\b|\btransfer\b/.test(t)) ||
    /\b(send|wire|transfer)\s+(?:them |her |him |me )?(?:\$\s*\d+|money)\b/i.test(t) ||
    /\bsend money\b|\bmove money\b|\bwire money\b/i.test(t) ||
    /\bpay (?:the )?(?:invoice|bill|rent|landlord)\b/i.test(t) ||
    /\b(?:charge|refund) (?:the )?(?:card|customer|stripe)\b/i.test(t) ||
    /\bstripe (?:charge|payout|transfer|refund)\b/i.test(t)
  )
}

export function looksLikeHealthDiagnosis(text: string) {
  const t = String(text || '')
  return (
    /\bdiagnos(?:e|is|ing)\b/i.test(t) ||
    /\bprescri(?:be|ption)\b/i.test(t) ||
    /\b(do i have|is this|could this be|what(?:'s| is) wrong with (?:me|my))\b.{0,48}\b(cancer|covid|infection|disease|std|clot|stroke|heart attack|pneumonia|ulcer|tumor)\b/i.test(
      t,
    ) ||
    /\b(what disease|which disease|is it cancer)\b/i.test(t)
  )
}

export function looksLikeHighStakesLegal(text: string) {
  const t = String(text || '')
  if (looksLikePrep(t) && !/\b(legal advice|is this legal|sue|lawsuit)\b/i.test(t)) return false
  return (
    /\b(?:sue|lawsuit|litigation|malpractice)\b/i.test(t) ||
    /\b(?:is (?:this|that|it) legal|legally binding|enforceable)\b/i.test(t) ||
    /\blegal advice\b|\battorney\b/i.test(t) ||
    /\b(?:write|draft|send)\b.{0,32}\b(?:nda|will|trust|lease|subpoena)\b/i.test(t) ||
    /\bpower of attorney\b|\bretainer agreement\b/i.test(t) ||
    /\bimmigration (?:status|case|lawyer)\b/i.test(t)
  )
}

export function classifyHardStop(text: string): HardStop | null {
  if (looksLikeMoneyMovement(text)) return 'money'
  if (looksLikeHealthDiagnosis(text)) return 'health'
  if (looksLikeHighStakesLegal(text)) return 'legal'
  return null
}

export function hardStopInstruction(kind: HardStop) {
  if (kind === 'money') {
    return 'HARD STOP: unsupervised money movement. Do not venmo, wire, charge a card, pay an invoice, or send money. Do not attach Send for a payment. Logging spend they already made is fine only under the cap. Tell them you cannot move money. They have to do it themselves.'
  }
  if (kind === 'health') {
    return 'HARD STOP: health diagnosis. Do not name a disease, a dose, or a prescription. Do not claim it is nothing. Tell them you cannot diagnose. If it is urgent, tell them to get a clinician. You can still log meals, sleep, and mood.'
  }
  return 'HARD STOP: high stakes legal. Do not say what the law is. Do not draft a binding contract, NDA, will, or lease as advice. Do not send it. Tell them to talk to a lawyer. You can still prep them for a meeting with one.'
}

export type HumanLimit = 'grief' | 'negotiation' | 'taste'

export function looksLikeGrief(text: string) {
  const t = String(text || '')
  if (/\b(deadline|deadlift|dead inside|phone died|battery died)\b/i.test(t)) return false
  return (
    /\b(passed away|funeral|grieving|in mourning|memorial service)\b/i.test(t) ||
    /\b(my|our) (mom|dad|mother|father|brother|sister|partner|wife|husband|kid|child|friend)\b.{0,32}\b(died|dead|passed)\b/i.test(
      t,
    ) ||
    /\b(died|passed)\b.{0,32}\b(mom|dad|mother|father|brother|sister|partner|wife|husband)\b/i.test(t) ||
    /\bi lost my (mom|dad|mother|father|brother|sister|partner|wife|husband|kid|child)\b/i.test(t)
  )
}

export function looksLikeNegotiationClose(text: string) {
  const t = String(text || '')
  if (looksLikePrep(t)) return false
  return (
    /\bnegotiate (?:this|that|the|it) for me\b/i.test(t) ||
    /\b(?:handle|close|take) (?:the )?(?:deal|offer|negotiation) for me\b/i.test(t) ||
    /\byou (?:negotiate|close) (?:it|this|the deal)\b/i.test(t) ||
    /\bcounter (?:the )?offer for me\b/i.test(t) ||
    /\btalk them down for me\b/i.test(t)
  )
}

export function looksLikeUntaughtTaste(text: string) {
  const t = String(text || '')
  if (/\bpick (?:a |the )?(?:restaurant|place|spot|dinner)\b/i.test(t)) return false
  return (
    /\bwhich (?:one |place )?(?:is|looks) (?:cooler|better|more me|my vibe)\b/i.test(t) ||
    /\bpick (?:my|a) (?:vibe|aesthetic|look|style|taste)\b/i.test(t) ||
    /\bwhat(?:'s| is) my (?:taste|style|aesthetic)\b/i.test(t) ||
    /\bmake me (?:cool|tasteful)\b/i.test(t)
  )
}

export function classifyHumanLimit(text: string): HumanLimit | null {
  if (looksLikeGrief(text)) return 'grief'
  if (looksLikeNegotiationClose(text)) return 'negotiation'
  if (looksLikeUntaughtTaste(text)) return 'taste'
  return null
}

export function humanLimitInstruction(kind: HumanLimit, taughtTaste = false) {
  if (kind === 'grief') {
    return 'HUMAN LIMIT: grief. Be a friend. Listen. Do not replace the people who know them. Do not do therapy. Do not claim you are enough. Do not run the week, send mail, or ping anyone. If they need a human in the room, say that plainly. Stay with them in the text.'
  }
  if (kind === 'negotiation') {
    return 'HUMAN LIMIT: negotiation. You cannot replace them in the room. Prep talking points if they asked for prep. Do not send the offer, the counter, or close. Do not attach Send. Tell them they have to take the conversation.'
  }
  if (taughtTaste) {
    return 'HUMAN LIMIT: taste. Use only preferences already in memory. Do not invent a new house style. If memory is thin, give two options, not a fake identity.'
  }
  return 'HUMAN LIMIT: taste you have not taught. Do not invent who they are. Do not pick a house style. Ask one question or give two options. Never claim this is their taste.'
}

export function wantsOperatorWrite(text: string) {
  return (
    looksLikeMailWrite(text) ||
    looksLikeEventWrite(text) ||
    looksLikeFollowUp(text) ||
    looksLikePrep(text)
  )
}

export function parseToolCall(text: string): { tool: LiveTool; query: string } | null {
  const m = String(text || '').match(TOOL_RE)
  if (!m) return null
  const query = (m[2] || '').trim()
  if (!query) return null
  return { tool: m[1] as LiveTool, query }
}

export function parseDraftCall(text: string): DraftCall | null {
  const raw = String(text || '')
  const reply = raw.match(DRAFT_REPLY_RE)
  if (reply) {
    const id = (reply[1] || '').trim()
    const body = (reply[2] || '').trim()
    if (id && body) return { type: 'reply', id, body }
  }
  const mail = raw.match(DRAFT_MAIL_RE)
  if (mail) {
    const to = (mail[1] || '').trim()
    const subject = (mail[2] || '').trim()
    const body = (mail[3] || '').trim()
    if (to && subject) return { type: 'mail', to, subject, body }
  }
  const event = raw.match(DRAFT_EVENT_RE)
  if (event) {
    const title = (event[1] || '').trim()
    const start = (event[2] || '').trim()
    const end = (event[3] || '').trim()
    if (title && start) return { type: 'event', title, start, end }
  }
  return null
}

export function stripToolDirectives(text: string): string {
  return String(text || '')
    .replace(DIRECTIVE_RE, '')
    .replace(/\bDRAFT_(?:MAIL|REPLY|EVENT)\b[^\n]*/gi, '')
    .replace(/\bTOOL\s+(?:maps|web|gmail|calendar|drive)\s+[^\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function nameFromText(text: string): string | null {
  const m = String(text || '').match(
    /\b(?:follow(?:ing)? up(?: with)?|reach out to|check in with|ping|reconnect with|text|sms|email|message|mail|prep(?: me)?(?: for)?|get me ready for|brief me (?:on|for))\s+(?:the |my |our )?(?:1-?1 with )?([A-Za-z][\w'.-]{1,40})/i,
  )
  if (m?.[1]) return m[1].replace(/['.]+$/g, '')
  const send = String(text || '').match(/\b(?:send|email)\s+([A-Za-z][\w'.-]{1,40})\b/i)
  return send?.[1]?.replace(/['.]+$/g, '') || null
}

export function matchPerson(text: string, people: PersonHit[]): PersonHit | null {
  const q = (nameFromText(text) || '').toLowerCase()
  if (!q || q === 'me' || q === 'them' || q === 'him' || q === 'her') return null
  const hit = people.find((p) => {
    const name = p.name.toLowerCase()
    const first = name.split(/\s+/)[0] || name
    return name === q || first === q || name.startsWith(q)
  })
  return hit || null
}

export function matchTextPerson(
  text: string,
  people: Array<{ name: string; phone?: string; email?: string }>,
): { name: string; phone: string } | null {
  const hit = matchPerson(text, people)
  return hit?.phone ? { name: hit.name, phone: hit.phone } : null
}

export function pingMail(person: PersonHit): DraftCall | null {
  const to = (person.email || '').trim()
  if (!to) return null
  const first = person.name.split(/\s+/)[0] || person.name
  return {
    type: 'mail',
    to,
    subject: `Checking in`,
    body: `Hey ${first}, checking in. How are things on your end?`,
  }
}

export type MapPick = { pick: string; alternate?: string; link?: string }

/**
 * Parse a "Map results for ..." block: "- Name (type)" lines are places and an
 * indented URL rides with the block. First place is the pick, second is the
 * alternate, first link found is the pick's link. Empty or non-maps text is
 * null.
 */
export function pickMapRecommendation(resultText: string): MapPick | null {
  const names: string[] = []
  let link: string | undefined
  for (const line of String(resultText || '').split('\n')) {
    const trimmed = line.trim()
    if (!link) {
      const url = trimmed.match(/https?:\/\/\S+/)?.[0]
      if (url) link = url.replace(/[),.;]+$/, '')
    }
    if (trimmed.startsWith('- ')) {
      const name = trimmed
        .slice(2)
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim()
      if (/[a-z0-9]/i.test(name)) names.push(name)
    }
  }
  if (!names.length) return null
  return {
    pick: names[0],
    ...(names[1] ? { alternate: names[1] } : {}),
    ...(link ? { link } : {}),
  }
}

export function parsePlannerTool(raw: string): { tool: LiveTool; query: string } | null {
  const tool = (String(raw || '').match(/"tool"\s*:\s*"(maps|web|gmail|calendar|drive|none)"/) || [])[1]
  if (!tool || tool === 'none') return null
  const query = (String(raw || '').match(/"query"\s*:\s*"([^"]+)"/) || [])[1] || ''
  if (!query.trim()) return null
  return { tool: tool as LiveTool, query: query.trim() }
}

export function parseExtractedWrite(raw: string): DraftCall | null {
  const action = (String(raw || '').match(/"action"\s*:\s*"(mail|reply|event|none)"/) || [])[1]
  if (!action || action === 'none') return null
  const field = (key: string) => {
    const m = String(raw || '').match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))
    return (m?.[1] || '').trim()
  }
  if (action === 'mail') {
    const to = field('to')
    const subject = field('subject')
    const body = field('body')
    if (to && subject) return { type: 'mail', to, subject, body }
  }
  if (action === 'reply') {
    const id = field('id')
    const body = field('body')
    if (id && body) return { type: 'reply', id, body }
  }
  if (action === 'event') {
    const title = field('title')
    const start = field('start')
    const end = field('end')
    if (title && start) return { type: 'event', title, start, end }
  }
  return null
}
