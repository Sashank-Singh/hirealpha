import type { BriefAsk, BriefMailGroup, BriefStory, CarryOverItem, EveningDayFact, HabitToday } from './briefStory'
import { isOpenableMail } from './briefMail'

type ReadStatus = 'ok' | 'not_connected' | 'auth_expired' | 'timeout' | 'provider_error'

export type FriendBriefData = {
  date?: string
  generatedAt?: number
  meetings?: Array<{ time: string; title: string; startsInMin?: number; prep?: boolean; prepWhy?: string }>
  calendar?: string[]
  calendarConnected?: boolean
  weather?: { temp: number; unit: string; condition: string }
  story?: BriefStory
  needsYou?: Array<BriefAsk & { score: number; reasons: string[] }>
  mailFailed?: boolean
  calendarFailed?: boolean
  mailStatus?: ReadStatus
  calendarStatus?: ReadStatus
  attention?: (BriefAsk & { why: string }) | null
  emailItems?: BriefAsk[]
  mailGroups?: BriefMailGroup[]
  sections?: Array<{ heading: string; items: string[]; emailMeta?: Array<{ id: string; snippet?: string; kind?: string }> }>
  dayFacts?: EveningDayFact[]
  habitsToday?: HabitToday[]
  carryOver?: CarryOverItem[]
  tomorrow?: string[]
  pending?: boolean
}

export type BriefMail = BriefAsk & { reason?: string }

/** Keep source ids intact: a promise is never an email, and a snippet is never a subject. */
export function friendBriefModel(data: FriendBriefData, evening: boolean, elapsedMinutes = 0) {
  const groups = data.story?.mailGroups?.length ? data.story.mailGroups : data.mailGroups ?? []
  const section = (name: string) => data.sections?.find(s => s.heading === name)
  const mail = new Map<string, BriefMail>()
  const recent = new Map<string, BriefMail>()
  const addPriority = (item: BriefMail) => {
    if (isOpenableMail(item.id) && !mail.has(item.id)) mail.set(item.id, item)
  }
  const addRecent = (item: BriefMail) => {
    if (item.id && !recent.has(item.id)) recent.set(item.id, item)
  }

  if (!evening) {
    const ranked = [...(data.story?.needsYou ?? data.needsYou ?? [])].sort((a, b) => b.score - a.score)
    const attention = data.attention
    const attentionIsNoise = !!attention && /\b(receipt|order confirmation|newsletter|sale|promo)\b/i.test(`${attention.label} ${attention.snippet || ''}`)
    const attentionIsUrgent = !!attention && /\b(due|deadline|overdue|expires?|rsvp|payment)\b/i.test(attention.why)
    const promoteAttention = !!attention && !attentionIsNoise && (ranked.some(m => m.id === attention.id) || !ranked.length || attentionIsUrgent)
    if (attention && promoteAttention) {
      addPriority({ ...attention, reason: attention.why })
    }
    for (const item of ranked) {
      addPriority({ ...item, reason: item.reasons.includes('deadline') ? 'A deadline to check' : 'Waiting for your reply' })
    }
    if (attention && !promoteAttention) addRecent(attention)
  }
  for (const group of groups) {
    for (const item of group.items) {
      if (group.kind === 'reply' && isOpenableMail(item.id)) addPriority({ ...item, reason: 'Waiting for your reply' })
      else addRecent(item)
    }
  }

  // The evening API's three lead messages are simply recent mail. Its judged
  // kind, when present, is the only basis for offering a reply as the next job.
  const eveningMail = section('Mail today') ?? section('Mail since this morning')
  for (const [index, meta] of (eveningMail?.emailMeta ?? []).entries()) {
    const original = groups.flatMap(g => g.items).find(item => item.id === meta.id)
    const item = { ...meta, label: original?.label ?? eveningMail?.items[index] ?? 'Message from today', reason: 'From today’s mail' }
    if (meta.kind === 'reply') addPriority(item)
    else addRecent(item)
  }
  if (!evening && !groups.length) for (const item of data.emailItems ?? data.story?.asks ?? []) addRecent(item)
  const otherMail = [...recent.values()].filter(item => !mail.has(item.id))
  const meetings: NonNullable<FriendBriefData['meetings']> = data.meetings
    ? data.meetings.filter(m => m.startsInMin === undefined || m.startsInMin + 60 >= elapsedMinutes)
    : (data.story?.beats ?? []).map(b => ({ time: b.time, title: b.name }))
  const calendarStatus = data.calendarStatus ?? (data.story?.calendarStatus as ReadStatus | undefined)
  const mailStatus = data.mailStatus ?? (data.story?.mailStatus as ReadStatus | undefined)
  const calendarKnown = calendarStatus !== 'not_connected' && (data.calendarConnected ?? data.story?.calendarConnected) !== false
  const calendarFailed = !!(data.calendarFailed || data.story?.calendarFailed || (calendarStatus && !['ok', 'not_connected'].includes(calendarStatus)))
  const mailFailed = !!(data.mailFailed || data.story?.mailFailed || (mailStatus && !['ok', 'not_connected'].includes(mailStatus)))
  const tomorrowLines = evening ? section('Tomorrow')?.items ?? data.tomorrow ?? [] : data.tomorrow ?? data.story?.later ?? []
  const wins = (data.dayFacts ?? data.story?.dayFacts ?? []).filter(f => f.state === 'done' && !['habits', 'spend'].includes(f.key))
  return {
    mail: [...mail.values()], otherMail,
    meetings, calendarKnown, calendarFailed, calendarStatus, mailFailed, mailStatus,
    calendarLines: meetings.length ? [] : (data.calendar ?? []).filter(line => !/authorization expired|timed out|could not check/i.test(line)),
    tomorrow: tomorrowLines.filter(line => !/^nothing on the calendar\.?$|authorization expired|timed out|could not check/i.test(line)),
    loops: data.carryOver ?? data.story?.carryOver ?? [],
    wins,
    habits: data.habitsToday ?? data.story?.habitsToday ?? [],
    eveningPlans: (section('Left this evening')?.items ?? []).filter(line => !/^nothing left on the calendar\.|calendar is not connected/i.test(line)),
    tonightTasks: section('Needs you')?.items ?? [],
    earlier: section('Earlier today')?.items ?? [],
  }
}

export function mailLabel(label: string) {
  const separator = label.lastIndexOf(' · ')
  return separator < 0 ? { subject: label, sender: 'Your inbox' } : { subject: label.slice(0, separator), sender: label.slice(separator + 3) }
}
