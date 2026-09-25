import type { SQL } from 'bun'
import {
  googleAccessToken,
  fetchCalendarItems,
  startOfLocalDay,
  loadGmailRich,
} from '../connectors/hub'
import { googleEventsRaw } from '../google/actions'
import {
  extractOtherPerson,
  formatClock,
  formatDigestEventLabel,
  isHotelStayEvent,
} from '../calendarEvents'
import {
  cleanMailSnippet,
  extractGmailBody,
  type GmailMimePart,
} from '../gmailHelpers'
import { withTimeout } from '../utils/async'
import { stripHtml } from '../utils/text'
import { webSearchContext } from '../webSearch'
import { gmiBriefChat } from '../briefs/judgment'
import { pickUserTimezone } from '../timezones'

export function prepNeedle(raw: string): string {
  const m = raw.match(
    /\b(?:prep(?: me)?(?: for)?|get me ready for|brief me (?:on|for)|read me in (?:on|for))\s+(?:the |my |our |this )?(.+?)$/i,
  )
  const rest = m?.[1] || raw
  const cleaned = rest
    .replace(/\b(meeting|call|1-?1|sync|interview|today|tomorrow)\b/gi, ' ')
    .replace(/\bwith\b/gi, ' ')
    .replace(/[.?!]+$/g, '')
    .replace(/["()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || rest.replace(/[.?!]+$/g, '').trim()).slice(0, 80)
}

export function prepHayMatch(hay: string, needle: string): boolean {
  const n = needle.toLowerCase().trim()
  const h = hay.toLowerCase()
  if (!n || n.length < 2) return false
  const variants = [n, n.replace(/1-1/g, '1:1'), n.replace(/1:1/g, '1-1')]
  if (variants.some((v) => h.includes(v))) return true
  const nFirst = n.split(/\s+/).find((w) => w.length >= 3) || n.split(/\s+/)[0] || ''
  if (nFirst.length >= 2 && h.includes(nFirst)) return true
  const hFirst = h.split(/\s+/)[0] || ''
  return hFirst.length >= 3 && n.includes(hFirst)
}

export function firstNameOf(name: string): string {
  return (name.split(/\s+/)[0] || name).trim()
}

export async function loadGmailMessageBody(
  sql: SQL,
  userId: string,
  messageId: string,
  maxChars = 800,
): Promise<string> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return ''
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${access}` } },
  )
  if (!res.ok) return ''
  const data = (await res.json()) as { snippet?: string; payload?: GmailMimePart }
  const { text, html } = extractGmailBody(data.payload)
  const raw = (text || stripHtml(html) || data.snippet || '').replace(/\s+/g, ' ').trim()
  return raw.slice(0, Math.min(12000, Math.max(1, maxChars)))
}

/* The prep sheet format. Fixed sections so the sheet scans the same way every
 * time; the model only organizes what was gathered — it never invents. */
export const PREP_FORMAT = [
  'You write a short pre-meeting prep sheet. Use ONLY the gathered context. Never invent facts, names, numbers, or dates.',
  'Format exactly, with these section lines:',
  'PREP · {person or meeting name}',
  'WHEN: {time · event} or "nothing matching in the next two days"',
  'WHO: {one line — role, context, where you met, last touch}',
  'LAST THREAD: {one line — the newest email: what was said, any ask left open} or "no email in the last 90 days"',
  'HISTORY:',
  '- {up to three one-line older threads, newest first}',
  'OUT THERE:',
  '- {up to two lines of public info from the web results, only if it matters for the meeting}',
  'OPEN LOOPS:',
  '- {asks either side left unanswered, if any} or "none spotted"',
  'SAY / ASK:',
  '- {two or three concrete talking points or questions for the meeting, drawn only from the context}',
  'Rules: short plain lines. No markdown. No hyphens or dashes in prose. If a section has nothing, say so in one honest line instead of filler.',
].join('\n')

export async function buildPrepBundle(
  sql: SQL,
  user: { id: string; name?: string | null; timezone: string | null },
  query: string,
): Promise<{
  text: string
  draft?:
    | { kind: 'mail'; to: string; subject: string; body: string }
    | { kind: 'reply'; messageId: string; body: string }
} | null> {
  const needle = prepNeedle(query)
  const tz = user.timezone || 'America/Los_Angeles'
  const myName = user.name || null
  const now = new Date()
  const until = new Date(now.getTime() + 48 * 60 * 60 * 1000)

  const peopleRows = await sql`
    SELECT name, phone, email, context, where_met AS "whereMet", last_touch AS "lastTouch"
    FROM hire_network WHERE user_id = ${user.id}
    ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) DESC
    LIMIT 40
  `
  const people = peopleRows as Array<{
    name: string
    phone: string
    email: string
    context: string
    whereMet: string
    lastTouch: string | null
  }>
  const person =
    people.find((p) => needle && prepHayMatch(p.name, needle)) ||
    people.find((p) => needle && prepHayMatch(needle, p.name)) ||
    null

  const searchName = person?.name || needle

  let eventLabel = ''
  let eventTitle = ''
  const access = await googleAccessToken(sql, user.id, 'calendar')
  if (access) {
    const got = await withTimeout(
      fetchCalendarItems(access, { timeMin: now, timeMax: until, maxResults: 20 }),
      6000,
      { ok: false as const, status: 0 },
    )
    if (got.ok) {
      const hit =
        got.items.find((e) => {
          if (isHotelStayEvent(e) && !prepHayMatch(e.title, searchName)) return false
          return prepHayMatch(e.title, searchName) || prepHayMatch(e.description || '', searchName)
        }) ||
        (!needle
          ? got.items.find((e) => !e.allDay && !isHotelStayEvent(e))
          : undefined)
      if (hit) {
        eventTitle = extractOtherPerson(hit.title, myName) || hit.title
        eventLabel = formatDigestEventLabel(hit, tz, myName)
      }
    }
  }
  if (!eventLabel) {
    const rows = await withTimeout(
      googleEventsRaw(sql, user.id, { timeMin: now, timeMax: until, maxResults: 20 }),
      6000,
      [] as Array<{ id: string; title: string; start: string; end: string; allDay: boolean }>,
    )
    const hit = rows.find((e) => prepHayMatch(e.title, searchName) && !e.allDay)
    if (hit) {
      eventTitle = hit.title
      const start = formatClock(new Date(hit.start), tz)
      eventLabel = `${start} · ${hit.title}`
    }
  }

  const meetingRows = await sql`
    SELECT title, notes, briefing
    FROM hire_meetings
    WHERE user_id = ${user.id}
    ORDER BY created_at DESC
    LIMIT 20
  `
  const meeting = (meetingRows as Array<{ title: string; notes: string | null; briefing: string | null }>).find(
    (m) => prepHayMatch(m.title, searchName) && (m.notes || m.briefing),
  )
  const peopleNote = [person?.whereMet ? `Met at ${person.whereMet}` : '', person?.context || '']
    .filter(Boolean)
    .join('. ')
  const meetingNote = String(meeting?.notes || meeting?.briefing || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)

  /* Full context pass: every recent thread with this person (bodies for the
   * two newest), plus a public-web search on the name. The old prep read one
   * email's first 220 characters and called that a brief. */
  let threadId = ''
  const email = (person?.email || '').trim()
  const gmailQ = email
    ? `(from:${email} OR to:${email}) newer_than:90d`
    : searchName
      ? `"${searchName.replace(/"/g, '')}" newer_than:90d`
      : ''
  const rich = gmailQ ? await withTimeout(loadGmailRich(sql, user.id, gmailQ, 8), 8000, []) : []
  const threadLines: string[] = []
  for (const [i, m] of rich.slice(0, 4).entries()) {
    let last = ''
    if (i < 2) {
      const body = await withTimeout(loadGmailMessageBody(sql, user.id, m.id), 6000, '')
      last = (body || m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 220)
    } else {
      last = (m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 150)
    }
    const when = String(m.date || '').slice(0, 16)
    threadLines.push(`${i + 1}. ${m.subject || 'Mail'} — ${m.from || 'unknown'}${when ? ` — ${when}` : ''}: ${last}`)
  }
  threadId = rich[0]?.id || ''

  let webText = ''
  if (searchName) {
    const q = [searchName, person?.context].filter(Boolean).join(' ').slice(0, 160)
    webText = await withTimeout(webSearchContext(q), 8000, '')
  }

  const who = person?.name || eventTitle || needle || 'that meeting'
  const lastTouch = person?.lastTouch
    ? `${Math.max(1, Math.floor((Date.now() - new Date(person.lastTouch).getTime()) / 86_400_000))} days ago`
    : ''

  const gathered = [
    `MEETING: ${eventLabel || 'nothing matching in the next two days'}`,
    `PERSON: ${[person?.name || searchName || 'unknown', person?.email || '', peopleNote || 'no notes on file', lastTouch ? `last touched ${lastTouch}` : '']
      .filter(Boolean)
      .join(' | ')}`,
    `MEETING NOTES: ${meetingNote || 'none'}`,
    `EMAIL THREADS (newest first):\n${threadLines.length ? threadLines.join('\n') : 'no email with them in the last 90 days'}`,
    webText ? `WEB:\n${webText}` : 'WEB: nothing found',
  ].join('\n\n')

  const hasAnything = !!(person || eventLabel || peopleNote || meetingNote || threadId || threadLines.length)
  if (!hasAnything) return null

  /* The sheet is a fixed format; the model organizes the gathered facts into
   * it. If the model is down, the raw gather is still an honest sheet. */
  const fallbackText = [
    `Prep for ${who}`,
    `When: ${eventLabel || 'nothing on the next two days that matches'}`,
    `People note: ${peopleNote || 'none on file'}`,
    meetingNote ? `Meeting notes: ${meetingNote}` : '',
    threadLines.length ? `Threads:\n${threadLines.join('\n')}` : 'Thread: none in the last 90 days',
    webText ? `Web:\n${webText}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  let text = fallbackText
  try {
    const synthesized = await gmiBriefChat(PREP_FORMAT, gathered, 700, 14000, { plainText: true })
    if (synthesized?.trim()) text = synthesized.trim()
    else console.warn('[prep] synthesis empty, using raw gather')
  } catch (err) {
    console.warn('[prep] synthesis failed, using raw gather', err)
  }

  const first = firstNameOf(who)
  const whenBit = eventTitle || 'this'
  let draft:
    | { kind: 'mail'; to: string; subject: string; body: string }
    | { kind: 'reply'; messageId: string; body: string }
    | undefined
  if (threadId) {
    draft = {
      kind: 'reply',
      messageId: threadId,
      body: `Thanks ${first}. I am set for ${whenBit}.`,
    }
  } else if (email) {
    draft = {
      kind: 'mail',
      to: email,
      subject: eventTitle ? `Ahead of ${eventTitle}` : 'Checking in',
      body: `Hey ${first}, looking forward to ${whenBit}.`,
    }
  }

  return { text, draft }
}

/* ---- Coworker tools: meeting prep, auto standup, slots, linear triage ---- */

/** One calendar event that could be a meeting. Attendees stay null when the
 * source cannot say who is on the invite, so the picker does not drop it. */
export type PrepCandidate = {
  id: string
  title: string
  start: Date
  attendees: string[] | null
}

/** Google first so attendee lists survive; Composio calendars keep every event
 * because their payloads hide attendees. */
export async function loadPrepCandidates(
  sql: SQL,
  userId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<PrepCandidate[]> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (access) {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    url.searchParams.set('timeMin', timeMin.toISOString())
    url.searchParams.set('timeMax', timeMax.toISOString())
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '25')
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } })
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{
            id?: string
            summary?: string
            start?: { dateTime?: string; date?: string }
            attendees?: Array<{ email?: string }>
          }>
        }
        return (data.items || []).flatMap((it): PrepCandidate[] => {
          const start = it.start?.dateTime
            ? new Date(it.start.dateTime)
            : it.start?.date
              ? new Date(`${it.start.date}T12:00:00Z`)
              : null
          if (!start || Number.isNaN(start.getTime())) return []
          return [{
            id: it.id || crypto.randomUUID(),
            title: it.summary || '(untitled)',
            start,
            attendees: (it.attendees || [])
              .map((a) => String(a.email || '').toLowerCase())
              .filter(Boolean),
          }]
        })
      }
    } catch (err) {
      console.warn('[meeting/prep] google list failed', err)
    }
  }
  const rows = await googleEventsRaw(sql, userId, { timeMin, timeMax, maxResults: 25 })
  return rows
    .filter((r) => !r.allDay)
    .map((r) => ({ id: r.id, title: r.title, start: new Date(r.start), attendees: null }))
    .filter((e) => Number.isFinite(e.start.getTime()))
}

/** Next event today that counts as a meeting: either someone else is on the
 * invite or the source could not tell us. */
export function nextSharedMeeting(
  events: PrepCandidate[],
  now: number = Date.now(),
  dayEnd: number = Infinity,
): PrepCandidate | null {
  const upcoming = events
    .filter((e) => Number.isFinite(e.start.getTime()))
    .filter((e) => e.start.getTime() >= now - 10 * 60_000)
    .filter((e) => e.start.getTime() < dayEnd)
    .filter((e) => e.attendees === null || e.attendees.length >= 1)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
  return upcoming[0] ?? null
}

export type PrepThread = { subject: string; snippet: string; gmailId: string }

export type PrepBrief = {
  event: { id: string; title: string; startsInMin: number; attendees?: string[] } | null
  prep: { lastThread?: PrepThread; agenda: string[]; notes: string[] }
}

/** Deterministic skeleton: what the meeting is, who is on it, what to decide. */
export function buildPrepBrief(
  event: PrepCandidate,
  lastThread: PrepThread | null,
  now: number = Date.now(),
): PrepBrief {
  const startsInMin = Math.max(0, Math.round((event.start.getTime() - now) / 60_000))
  const who = (event.attendees || [])
    .map((a) => a.split('@')[0].replace(/[._]+/g, ' ').trim())
    .filter(Boolean)
  const first = who[0] ? who[0].replace(/\b\w/g, (c) => c.toUpperCase()) : 'them'
  const out: PrepBrief = {
    event: {
      id: event.id,
      title: event.title,
      startsInMin,
      ...(event.attendees && event.attendees.length ? { attendees: event.attendees } : {}),
    },
    prep: {
      agenda: [`Why: ${event.title}`, `Where ${first} stands`, 'Decisions to leave with'],
      notes: [
        startsInMin > 0 ? `Starts in ${startsInMin} min` : 'Starting now',
        who.length ? `With ${who.slice(0, 3).join(', ')}` : 'Attendee list unavailable',
      ],
    },
  }
  if (lastThread) out.prep.lastThread = lastThread
  return out
}

/** Most recent mail from the other side, so the prep can quote their last ask. */
export async function findLastThread(
  sql: SQL,
  userId: string,
  attendees: string[] | null,
): Promise<PrepThread | null> {
  const primary = (attendees || [])[0] || ''
  if (!primary) return null
  const domain = primary.includes('@') ? primary.split('@')[1] : ''
  const term = domain || primary.split('@')[0]
  if (!term) return null
  const rows = await loadGmailRich(sql, userId, `from:${term} newer_than:90d`, 1).catch(() => [])
  const m = rows[0]
  if (!m) return null
  return {
    subject: m.subject || '(no subject)',
    snippet: cleanMailSnippet(m.snippet || '').slice(0, 200),
    gmailId: m.id,
  }
}

export async function buildMeetingPrep(
  sql: SQL,
  user: { id: string; timezone: string | null },
): Promise<PrepBrief> {
  const tz = pickUserTimezone({ userTz: user.timezone })
  const now = new Date()
  const dayEnd = startOfLocalDay(tz, 1)
  const events = await loadPrepCandidates(sql, user.id, now, dayEnd).catch(() => [])
  const meeting = nextSharedMeeting(events, now.getTime(), dayEnd.getTime())
  if (!meeting) return { event: null, prep: { agenda: [], notes: [] } }
  const lastThread = await findLastThread(sql, user.id, meeting.attendees)
  return buildPrepBrief(meeting, lastThread, now.getTime())
}
