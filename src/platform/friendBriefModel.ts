import type { BriefAsk, BriefMailGroup, BriefStory, CarryOverItem, EveningDayFact, HabitToday } from './briefStory'

export type FriendBriefData = {
  date?: string
  meetings?: Array<{ time: string; title: string; startsInMin?: number }>
  calendar?: string[]
  calendarConnected?: boolean
  weather?: { temp: number; unit: string; condition: string }
  story?: BriefStory
  attention?: (BriefAsk & { why: string }) | null
  emailItems?: BriefAsk[]
  mailGroups?: BriefMailGroup[]
  sections?: Array<{ heading: string; items: string[]; emailMeta?: Array<{ id: string; snippet?: string }> }>
  dayFacts?: EveningDayFact[]
  habitsToday?: HabitToday[]
  carryOver?: CarryOverItem[]
  tomorrow?: string[]
  pending?: boolean
}

export type BriefMail = BriefAsk & { reason?: string }

/** Keep source ids intact: a promise is never an email, and a snippet is never a subject. */
export function friendBriefModel(data: FriendBriefData, evening: boolean) {
  const groups = data.mailGroups ?? data.story?.mailGroups ?? []
  const section = (name: string) => data.sections?.find(s => s.heading === name)
  const mail = new Map<string, BriefMail>()
  const add = (item: BriefMail) => { if (item.id && !mail.has(item.id)) mail.set(item.id, item) }
  if (data.attention) add({ ...data.attention, reason: data.attention.why })
  for (const item of [...(data.story?.needsYou ?? [])].sort((a, b) => b.score - a.score)) {
    add({ ...item, reason: item.reasons.includes('deadline') ? 'A deadline to check' : 'Waiting for your reply' })
  }
  for (const item of groups.find(g => g.kind === 'reply')?.items ?? []) add({ ...item, reason: 'Waiting for your reply' })
  const eveningMail = section('Mail since this morning')
  for (const [index, meta] of (eveningMail?.emailMeta ?? []).entries()) {
    const original = groups.flatMap(g => g.items).find(item => item.id === meta.id)
    add({ ...meta, label: original?.label ?? eveningMail?.items[index] ?? 'Message from today', reason: 'From today’s mail' })
  }
  if (!groups.length && !mail.size) for (const item of data.emailItems ?? data.story?.asks ?? []) add(item)
  const otherMail = groups.flatMap(g => g.items).filter((item, index, all) => !mail.has(item.id) && all.findIndex(m => m.id === item.id) === index)
  const meetings = data.meetings?.length
    ? data.meetings.filter(m => m.startsInMin === undefined || m.startsInMin >= 0)
    : (data.story?.beats ?? []).map(b => ({ time: b.time, title: b.name }))
  const calendarKnown = (data.calendarConnected ?? data.story?.calendarConnected) !== false
  return {
    mail: [...mail.values()], otherMail,
    meetings, calendarKnown,
    calendarLines: meetings.length ? [] : data.calendar ?? [],
    tomorrow: evening ? section('Tomorrow')?.items ?? data.tomorrow ?? [] : data.tomorrow ?? data.story?.later ?? [],
    loops: data.carryOver ?? data.story?.carryOver ?? [],
    wins: (data.dayFacts ?? data.story?.dayFacts ?? []).filter(f => f.state === 'done'),
    unfinished: (data.dayFacts ?? data.story?.dayFacts ?? []).filter(f => f.state !== 'done'),
    habits: data.habitsToday ?? data.story?.habitsToday ?? [],
    eveningPlans: section('Left this evening')?.items ?? [],
    earlier: section('Earlier today')?.items ?? [],
  }
}

export function mailLabel(label: string) {
  const separator = label.lastIndexOf(' · ')
  return separator < 0 ? { subject: label, sender: 'Your inbox' } : { subject: label.slice(0, separator), sender: label.slice(separator + 3) }
}
