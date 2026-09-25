import type { SQL } from 'bun'
import {
  pickUserTimezone,
  localDateStrInTz,
  todayWindowUtc,
  wallTimeToUtc,
  shiftDateStr,
} from '../timezones'
import { loadPrepCandidates } from './prep'
import {
  googleAccessToken,
  composioClient,
  composioFirst,
  connectedForUser,
  startOfLocalDay,
  loadGmailRich,
} from '../connectors/hub'
import { googleEventsRaw, localHourParts } from '../google/actions'
import { cleanMailSnippet, importantMailQuery } from '../gmailHelpers'
import { judgeBriefMail } from '../briefs/judgment'
import { JUDGE_MAIL_CAP } from '../aiJudge'
import { isDemoUserId, demoLinearIssuesForUser } from '../demoData'
import { selectNextEvents, isWalkIn } from '../calendarEvents'
import { PERSONA_DENIED, type Persona } from '../personas'

export type StandupFacts = {
  day: string
  meetings: string[]
  closedPromises: string[]
  draftsSent: string[]
  decisions: string[]
  blocked: string[]
}

/** Fixed sections: what closed since the last one, what is on today, what is
 * stuck. Empty day says so instead of printing bare headers. */
export function assembleStandupText(f: StandupFacts): string {
  const lines: string[] = [`Standup ${f.day}`]
  const done = [
    ...f.closedPromises.map((t) => `Closed: ${t}`),
    ...f.draftsSent.map((d) => `Sent: ${d}`),
  ]
  if (done.length) lines.push('Yesterday:', ...done.map((t) => `- ${t}`))
  const today = [
    ...f.meetings.map((m) => `Meeting: ${m}`),
    ...f.decisions.map((d) => `Decision: ${d}`),
  ]
  if (today.length) lines.push('Today:', ...today.map((t) => `- ${t}`))
  if (f.blocked.length) lines.push('Blocked:', ...f.blocked.map((t) => `- ${t}`))
  if (!done.length && !today.length && !f.blocked.length) lines.push('Quiet day. Nothing logged.')
  return lines.join('\n')
}

/** Standup from real rows only: calendar, loops closed today, drafts sent
 * today, decisions logged today. Blocked means a promise due today still open. */
export async function assembleAutoStandup(
  sql: SQL,
  user: { id: string; timezone: string | null },
): Promise<{ text: string; day: string }> {
  const tz = pickUserTimezone({ userTz: user.timezone })
  const day = localDateStrInTz(new Date(), tz)
  const win = todayWindowUtc(tz)
  const events = await loadPrepCandidates(sql, user.id, win.start, win.end).catch(() => [])
  const closed = (await sql`
    SELECT title FROM hire_loops
    WHERE user_id = ${user.id} AND status = 'done'
      AND updated_at >= ${win.start} AND updated_at < ${win.end}
    ORDER BY updated_at LIMIT 10
  `) as Array<{ title: string }>
  const drafts = (await sql`
    SELECT subject FROM hire_drafts
    WHERE user_id = ${user.id} AND status = 'sent'
      AND created_at >= ${win.start} AND created_at < ${win.end}
    ORDER BY created_at LIMIT 10
  `) as Array<{ subject: string }>
  const decisions = (await sql`
    SELECT decision FROM hire_decisions
    WHERE user_id = ${user.id} AND created_at >= ${win.start} AND created_at < ${win.end}
    ORDER BY created_at LIMIT 10
  `) as Array<{ decision: string }>
  const blocked = (await sql`
    SELECT title FROM hire_loops
    WHERE user_id = ${user.id} AND status = 'open'
      AND due_at >= ${win.start} AND due_at < ${win.end}
    ORDER BY due_at LIMIT 10
  `) as Array<{ title: string }>
  const text = assembleStandupText({
    day,
    meetings: events.map((e) => e.title).filter(Boolean).slice(0, 6),
    closedPromises: closed.map((r) => r.title),
    draftsSent: drafts.map((r) => r.subject || 'a draft'),
    decisions: decisions.map((r) => r.decision),
    blocked: blocked.map((r) => r.title),
  })
  await sql`
    INSERT INTO hire_standups (id, user_id, day, notes)
    VALUES (${crypto.randomUUID()}, ${user.id}, ${day}, ${text})
    ON CONFLICT (user_id, day) DO UPDATE SET notes = excluded.notes, created_at = now()
  `
  return { text, day }
}

/** Free gaps as labels, 30 min steps inside work hours, soonest first. */
export function formatSlotLabel(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  return `${get('weekday')} ${get('hour')}:${get('minute')}`
}

export type SlotRange = { start: string; end: string; label: string }

/** The hours a part of the day spans, in the user's timezone. */
export function partOfDayWindow(part: string | undefined): { start: number; end: number } | null {
  const p = String(part || '').toLowerCase().trim()
  if (/^(?:morning|am)\b/.test(p)) return { start: 9, end: 12 }
  if (/^(?:afternoon|midday|pm)\b/.test(p)) return { start: 12, end: 18 }
  if (/^(?:evening|night)\b/.test(p)) return { start: 17, end: 21 }
  return null
}

/**
 * Free 30-minute steps inside work hours as real ranges, with their labels.
 * `suggestSlotsFromBusy` is the label-only view of this; the chat engine needs
 * the ISO start/end too, because it drafts the calendar event itself and must
 * never draft one onto a busy block. `day` (YYYY-MM-DD, user's timezone)
 * narrows the walk to a single local date, which is how "a block on Thursday
 * afternoon" gets verified instead of guessed.
 */
export function suggestSlotRanges(
  busy: Array<{ start: number; end: number }>,
  opts: {
    now?: number
    windowDays?: number
    durationMin?: number
    timezone?: string
    workStartHour?: number
    workEndHour?: number
    day?: string
    limit?: number
  } = {},
): SlotRange[] {
  const tz = opts.timezone || 'America/Los_Angeles'
  const now = opts.now ?? Date.now()
  const windowDays = Math.min(7, Math.max(1, Math.round(opts.windowDays || 3)))
  const durationMin = Math.min(240, Math.max(15, Math.round(opts.durationMin || 30)))
  const workStart = opts.workStartHour ?? 9
  const workEnd = opts.workEndHour ?? 18
  const limit = Math.min(12, Math.max(1, Math.round(opts.limit || 3)))
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.day || '')) ? String(opts.day) : ''
  const firstYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
  const days = day ? [day] : Array.from({ length: windowDays }, (_, d) => shiftDateStr(firstYmd, d))
  const slots: SlotRange[] = []
  for (const ymd of days) {
    for (let minute = workStart * 60; minute + durationMin <= workEnd * 60 && slots.length < limit; minute += 30) {
      const start = wallTimeToUtc(ymd, Math.floor(minute / 60), minute % 60, tz).getTime()
      if (start < now) continue
      const end = start + durationMin * 60_000
      if (busy.some((b) => start < b.end && end > b.start)) continue
      slots.push({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        label: formatSlotLabel(new Date(start), tz),
      })
    }
  }
  return slots
}

export function suggestSlotsFromBusy(
  busy: Array<{ start: number; end: number }>,
  opts: {
    now?: number
    windowDays?: number
    durationMin?: number
    timezone?: string
    workStartHour?: number
    workEndHour?: number
  } = {},
): string[] {
  return suggestSlotRanges(busy, opts).map((slot) => slot.label)
}

/** freeBusy when Google is wired, event times otherwise. */
export async function loadBusyBlocks(
  sql: SQL,
  userId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<Array<{ start: number; end: number }>> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (access) {
    try {
      const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: 'primary' }] }),
      })
      if (res.ok) {
        const data = (await res.json()) as { calendars?: { primary?: { busy?: Array<{ start: string; end: string }> } } }
        const blocks = (data.calendars?.primary?.busy || [])
          .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
          .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
        if (blocks.length) return blocks
      }
    } catch (err) {
      console.warn('[slots] freeBusy failed', err)
    }
  }
  const rows = await googleEventsRaw(sql, userId, { timeMin, timeMax, maxResults: 50 })
  return rows
    .filter((r) => !r.allDay)
    .map((r) => ({
      start: Date.parse(r.start),
      end: r.end ? Date.parse(r.end) : Date.parse(r.start) + 3_600_000,
    }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
}

export type LinearIssueInput = {
  id: string
  title: string
  updatedAt: number | null
  priority: string
  lastCommentAt: number | null
}

function linearMs(v: unknown): number | null {
  if (!v) return null
  const t = new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}

const LINEAR_PRIORITY_NUMBERS: Record<number, string> = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' }

/** Loose parse of whatever the Composio list returned. Only rows with a title
 * count; anything else is noise the walk ignores. */
export function parseLinearIssues(raw: unknown): LinearIssueInput[] {
  let data = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return []
    try {
      data = JSON.parse(trimmed)
    } catch {
      return []
    }
  }
  const out: LinearIssueInput[] = []
  const walk = (node: unknown, depth: number) => {
    if (out.length >= 60 || depth > 5 || node == null) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const o = node as Record<string, unknown>
    const title = String(o.title || '').trim()
    if (title) {
      const prioRaw = o.priority ?? o.priorityLabel ?? ''
      const priority =
        typeof prioRaw === 'number' ? LINEAR_PRIORITY_NUMBERS[prioRaw] || '' : String(prioRaw).toLowerCase()
      const comments = Array.isArray(o.comments) ? (o.comments[o.comments.length - 1] as Record<string, unknown> | undefined) : undefined
      out.push({
        id: String(o.id || o.identifier || title).slice(0, 80),
        title: title.slice(0, 200),
        updatedAt: linearMs(o.updatedAt ?? o.updated_at),
        priority,
        lastCommentAt: linearMs(o.lastCommentAt ?? comments?.updatedAt),
      })
    }
    for (const v of Object.values(o)) walk(v, depth + 1)
  }
  walk(data, 0)
  return out
}

/** Stale first: age plus priority words plus a fresh comment. Top 3 are now,
 * the next 5 are next, the rest only show as a count. */
export function scoreLinearIssues(
  issues: LinearIssueInput[],
  now: number = Date.now(),
): { now: Array<{ id: string; title: string; score: number }>; next: Array<{ id: string; title: string; score: number }>; later: number } {
  const day = 86_400_000
  const scored = issues.map((i) => {
    let score = 0
    if (i.updatedAt) score += Math.max(0, Math.floor((now - i.updatedAt) / day))
    const text = `${i.title} ${i.priority}`.toLowerCase()
    if (/\burgent\b/.test(text)) score += 7
    else if (/\bhigh\b/.test(text)) score += 4
    if (i.lastCommentAt && now - i.lastCommentAt <= 2 * day) score += 3
    return { id: i.id, title: i.title, score }
  })
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  return {
    now: scored.slice(0, 3),
    next: scored.slice(3, 8),
    later: Math.max(0, scored.length - 8),
  }
}

export function walkLinearIssues(
  data: unknown,
  out: Array<{ id: string; identifier: string; title: string; state?: string; team?: string; dueAt?: string }> = [],
): Array<{ id: string; identifier: string; title: string; state?: string; team?: string; dueAt?: string }> {
  if (out.length >= 12 || data == null) return out
  if (Array.isArray(data)) {
    for (const item of data) walkLinearIssues(item, out)
    return out
  }
  if (typeof data !== 'object') return out
  const o = data as Record<string, unknown>
  const id = String(o.id || o.issueId || o.issue_id || '')
  const title = String(o.title || o.name || '')
  const identifier = String(o.identifier || o.number || o.key || '')
  if (id && title) {
    const state = typeof o.state === 'object' && o.state
      ? String((o.state as { name?: string }).name || '')
      : String(o.state || o.status || '')
    const team = typeof o.team === 'object' && o.team
      ? String((o.team as { name?: string }).name || '')
      : String(o.team || '')
    const dueAt = String(o.dueDate || o.due_at || o.dueAt || o.deadline || '')
    if (!out.some((x) => x.id === id)) out.push({
      id, identifier: identifier || title.slice(0, 8), title, state, team,
      ...(Number.isFinite(Date.parse(dueAt)) ? { dueAt: new Date(dueAt).toISOString() } : {}),
    })
    return out
  }
  for (const v of Object.values(o)) walkLinearIssues(v, out)
  return out
}

export async function listLinearIssues(userId: string) {
  if (isDemoUserId(userId)) return demoLinearIssuesForUser(userId)
  const composio = composioClient()
  if (!composio) return { issues: [] as ReturnType<typeof walkLinearIssues>, needConnect: true }
  for (const slug of ['LINEAR_LIST_ISSUES', 'LINEAR_LIST_LINEAR_ISSUES', 'LINEAR_GET_ISSUES']) {
    try {
      const res = await composio.tools.execute(slug, {
        userId,
        arguments: { limit: 12 },
        dangerouslySkipVersionCheck: true,
      })
      if (!res?.successful) continue
      const issues = walkLinearIssues(res.data)
      if (issues.length) return { issues, needConnect: false }
    } catch {
      /* try next slug */
    }
  }
  return { issues: [] as ReturnType<typeof walkLinearIssues>, needConnect: false }
}

export async function linearWrite(userId: string, id: string, action: 'done' | 'later' | 'cancel') {
  // Demo Linear is read-only; the card closes its row locally either way.
  if (isDemoUserId(userId)) return false
  const state = action === 'done' ? 'Done' : action === 'cancel' ? 'Canceled' : 'Backlog'
  const out = await composioFirst(
    userId,
    ['LINEAR_UPDATE_ISSUE', 'LINEAR_UPDATE_ISSUE_STATUS', 'LINEAR_MARK_ISSUE_AS_DONE'],
    { id, issueId: id, issue_id: id, state, status: state },
  )
  return !!(out && !/failed/i.test(out))
}

/** Automated senders never get drafts — replying to a no-reply bot is the
 * single most embarrassing thing the work home ever did. */
export const AUTOMATED_SENDER =
  /no[-_.]?reply|donotreply|do[_-]?not[_-]?reply|not[-_]?reply|notifications?@|newsletter|mailer-daemon|postmaster|auto[-_.]?(?:reply|confirm|respond|generated)|alerts?@|noreply|bounce|daemon@|feedback@/i

export function isAutomatedSender(addr: string): boolean {
  return AUTOMATED_SENDER.test(String(addr || '').toLowerCase())
}

/** Subjects that are machine notifications, not conversations. */
export const AUTOMATED_SUBJECT =
  /^(?:unread message|reminder to|assessment|your (?:receipt|assessment|application|results))|(?:submitted for|testing for|complete .{0,24} for LLM|action required|verify your|confirm your|was (?:cancel|reschedul)|has been cancel|starts? (?:in|at) |is (?:live|starting) now|your event)/i

export function isAutomatedSubject(s: string): boolean {
  return AUTOMATED_SUBJECT.test(String(s || '').trim())
}

export type NextRow = {
  id: string
  kicker: string
  title: string
  hint?: string
  hot?: boolean
  action: string
  doLabel?: string
  draftId?: string
  loopId?: string
  personId?: string
  issueId?: string
  eventId?: string
  pipelineId?: string
  stage?: string
  start?: string
  end?: string
  sms?: string
  openKind?: string
  messageId?: string
}

export async function buildNextStack(
  sql: SQL,
  user: { id: string; timezone: string | null },
  persona: Persona,
): Promise<{ items: NextRow[]; connected: string[]; missing: string[] }> {
  const tz = pickUserTimezone({ userTz: user.timezone })
  const connected = (await connectedForUser(sql, user.id)).filter((id) => !PERSONA_DENIED[persona].has(id))
  const want = persona === 'friend' ? ['gmail', 'calendar'] : persona === 'coworker' ? ['gmail', 'calendar', 'linear'] : ['gmail', 'calendar']
  const missing = want.filter((id) => !connected.includes(id))
  const items: NextRow[] = []
  const now = Date.now()

  let events: Array<{ id: string; title: string; start: string; end: string; allDay: boolean }> = []
  if (connected.includes('calendar')) {
    try {
      events = await googleEventsRaw(sql, user.id, {
        timeMin: new Date(now - 5 * 60_000),
        timeMax: startOfLocalDay(tz, 2),
        maxResults: 12,
      })
    } catch (err) {
      console.warn('[work/next] calendar failed', err)
    }
  }
  for (const ev of selectNextEvents(events, now)) {
    const walk = !ev.allDay && isWalkIn(ev.start, now)
    items.push({
      id: `meet-${ev.id}`,
      kicker: walk ? 'Now' : ev.allDay ? 'All day' : 'Next',
      title: ev.title,
      hint: ev.allDay ? 'On the calendar' : localHourParts(ev.start, tz),
      hot: walk,
      action: 'open',
      doLabel: walk ? 'Prep' : 'Open',
      openKind: persona === 'coworker' ? 'meeting_mode' : 'digest',
      eventId: ev.id,
    })
  }

  if (connected.includes('gmail')) {
    try {
      const richMail = await loadGmailRich(sql, user.id, importantMailQuery('2d'), JUDGE_MAIL_CAP)
      const keptMail = await judgeBriefMail(richMail, 3)
      for (const m of keptMail) {
        items.push({
          id: `mail-${m.id}`,
          kicker: 'Mail',
          title: m.subject || '(no subject)',
          hint: cleanMailSnippet(m.snippet) || m.from.replace(/<[^>]+>/g, '').trim(),
          action: 'open',
          doLabel: 'Read',
          openKind: 'digest',
          messageId: m.id,
        })
      }
    } catch (err) {
      console.warn('[work/next] mail failed', err)
    }
  }

  let drafts: Array<{ id: string; toAddr: string; subject: string }> = []
  try {
    drafts = ((await sql`
      SELECT id, to_addr AS "toAddr", subject FROM hire_drafts
      WHERE user_id = ${user.id} AND status = 'pending'
      ORDER BY created_at DESC LIMIT 3
    `) as Array<{ id: string; toAddr: string; subject: string }>).filter((d) => !isAutomatedSender(d.toAddr) && !isAutomatedSubject(d.subject))
  } catch {
    drafts = []
  }
  for (const d of drafts) {
    items.push({
      id: `draft-${d.id}`,
      kicker: 'Draft ready',
      title: d.subject || 'Draft',
      hint: `For ${d.toAddr}. Review before it goes out.`,
      hot: true,
      action: 'open',
      doLabel: 'Review',
      openKind: 'approve_send',
      draftId: d.id,
    })
  }

  let loops: Array<{ id: string; title: string; dueAt: Date | null }> = []
  try {
    loops = (await sql`
      SELECT id, title, due_at AS "dueAt" FROM hire_loops
      WHERE user_id = ${user.id} AND status = 'open'
      ORDER BY due_at ASC NULLS LAST LIMIT 6
    `) as Array<{ id: string; title: string; dueAt: Date | null }>
  } catch (err) {
    console.warn('[work/next] loops failed', err)
  }
  const dueLoop = loops.find((l) => l.dueAt && new Date(l.dueAt).getTime() <= now + 12 * 60 * 60 * 1000) || loops[0]
  if (dueLoop) {
    items.push({
      id: `loop-${dueLoop.id}`,
      kicker: 'Promise',
      title: dueLoop.title,
      hint: dueLoop.dueAt ? 'Due' : 'Open',
      hot: true,
      action: 'loop',
      doLabel: 'Close',
      loopId: dueLoop.id,
    })
  }

  let people: Array<{ id: string; name: string; context: string; lastTouch: Date | null; cadenceDays: number }> = []
  try {
    people = (await sql`
      SELECT id, name, context, last_touch AS "lastTouch", cadence_days AS "cadenceDays"
      FROM hire_network WHERE user_id = ${user.id}
      ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC LIMIT 12
    `) as Array<{ id: string; name: string; context: string; lastTouch: Date | null; cadenceDays: number }>
  } catch (err) {
    console.warn('[work/next] network failed', err)
  }
  const overdue = people.find((p) => {
    const last = p.lastTouch ? new Date(p.lastTouch).getTime() : 0
    return (Date.now() - last) / 86400000 >= (p.cadenceDays || 14)
  })
  if (overdue) {
    const draft = `Hey ${overdue.name.split(' ')[0]} — ${overdue.context || 'wanted to reconnect'}`
    items.push({
      id: `person-${overdue.id}`,
      kicker: 'Ping',
      title: overdue.name,
      hint: overdue.context || 'Overdue',
      hot: true,
      action: 'person',
      doLabel: 'Talked',
      personId: overdue.id,
      sms: `sms:&body=${encodeURIComponent(draft)}`,
    })
  }

  if (persona === 'coworker' && connected.includes('linear')) {
    const lin = await listLinearIssues(user.id)
    if (lin.issues[0]) {
      items.push({
        id: `lin-${lin.issues[0].id}`,
        kicker: 'Linear',
        title: lin.issues[0].title,
        hint: lin.issues[0].identifier,
        action: 'linear',
        doLabel: 'Later',
        issueId: lin.issues[0].id,
      })
    }
  }

  if (persona === 'cofounder') {
    const pipe = (await sql`
      SELECT id, title, stage FROM hire_pipeline
      WHERE user_id = ${user.id} AND stage NOT IN ('won', 'lost')
      ORDER BY updated_at DESC LIMIT 1
    `) as Array<{ id: string; title: string; stage: string }>
    if (pipe[0]) {
      const nextStage = pipe[0].stage === 'lead' ? 'active' : pipe[0].stage === 'active' ? 'interview' : pipe[0].stage === 'interview' ? 'offer' : 'won'
      items.push({
        id: `pipe-${pipe[0].id}`,
        kicker: pipe[0].stage,
        title: pipe[0].title,
        action: 'pipeline',
        doLabel: 'Advance',
        pipelineId: pipe[0].id,
        stage: nextStage,
      })
    }
  }

  return { items, connected, missing }
}
