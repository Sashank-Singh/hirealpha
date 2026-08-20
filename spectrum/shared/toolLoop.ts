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

If you still need a lookup that is not in Life right now, output exactly one line and stop:
TOOL maps <query>
TOOL web <query>
TOOL gmail <query>
TOOL calendar <query>
TOOL drive <query>

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
