export const LIVE_TOOLS = ['maps', 'web', 'gmail', 'calendar', 'drive'] as const
export type LiveTool = (typeof LIVE_TOOLS)[number]

export type DraftCall =
  | { type: 'mail'; to: string; subject: string; body: string }
  | { type: 'reply'; id: string; body: string }
  | { type: 'event'; title: string; start: string; end: string }

export const TOOL_LOOP_INSTRUCTIONS = `World model (Life right now) already has weekday, next 8 hours of calendar, judged mail, workout name, and people phones. Use it. Do not invent.

If you need a lookup that is not in that block, output exactly one line and stop:
TOOL maps <query>
TOOL web <query>
TOOL gmail <query>
TOOL calendar <query>
TOOL drive <query>

If they want mail sent or a calendar event created, do not send or book it. Output one line:
DRAFT_MAIL to=email@x.com | subject=Subject | body=The mail on one line
DRAFT_REPLY id=<gmail id from the mail lines> | body=The reply on one line
DRAFT_EVENT title=Title | start=2026-08-21T15:00 | end=2026-08-21T15:30

Then one short sentence telling them to tap Send or Book on the card. Never say you sent, booked, or texted.`

const TOOL_RE = /^\s*TOOL\s+(maps|web|gmail|calendar|drive)\s+(.+)\s*$/im
const DRAFT_MAIL_RE = /^\s*DRAFT_MAIL\s+to=([^|]+)\|\s*subject=([^|]+)\|\s*body=(.+)$/im
const DRAFT_REPLY_RE = /^\s*DRAFT_REPLY\s+id=([^|]+)\|\s*body=(.+)$/im
const DRAFT_EVENT_RE = /^\s*DRAFT_EVENT\s+title=([^|]+)\|\s*start=([^|]+)(?:\|\s*end=(.+))?$/im
const DIRECTIVE_RE = /^\s*(?:TOOL\s+(?:maps|web|gmail|calendar|drive)|DRAFT_(?:MAIL|REPLY|EVENT))\b.*$/gim

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
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function matchTextPerson(
  text: string,
  people: Array<{ name: string; phone?: string }>,
): { name: string; phone: string } | null {
  const m = String(text || '').match(
    /\b(?:text|sms|imessage|ping|message)\s+([A-Za-z][\w'.-]{1,40})/i,
  )
  if (!m) return null
  const q = (m[1] || '').replace(/['.]+$/g, '').toLowerCase()
  if (!q || q === 'me' || q === 'them') return null
  const hit = people.find((p) => {
    if (!p.phone) return false
    const name = p.name.toLowerCase()
    const first = name.split(/\s+/)[0] || name
    return name === q || first === q || name.startsWith(q)
  })
  return hit?.phone ? { name: hit.name, phone: hit.phone } : null
}
