export type BriefBeat = { time: string; name: string; kind: string }
export type BriefAsk = { id: string; label: string; snippet?: string }
export type BriefMailGroup = {
  kind: string
  label: string
  count: number
  items: BriefAsk[]
}
export type BriefDue = { name: string; days: number; phone?: string }
export type BriefDo = {
  kicker: string
  title: string
  hint: string
  cta: string
  openKind: string
  kind?: 'sleep_log' | 'mail' | 'prep' | 'ping' | 'quiet'
  prepName?: string
}

/** Closed fact for the strip under the lead. A gap never also appears as an ask. */
export type BriefFact = { key: string; text: string; state: 'ok' | 'gap'; openKind?: string }
/** A scored mail that leads the brief. */
export type NeedsYouItem = { id: string; label: string; snippet?: string; score: number; reasons: string[] }
export type EveningDayFact = { key: string; label: string; detail: string; state: 'done' | 'miss' | 'partial' }
export type HabitToday = { id: string; name: string; emoji: string; done: boolean }
export type CarryOverItem = { id: string; title: string; dueLabel?: string }

export type BriefStory = {
  kicker: string
  date: string
  lead: string
  sub?: string
  do: BriefDo
  where?: { title: string; place?: string } | null
  beats: BriefBeat[]
  asks: BriefAsk[]
  mailGroups?: BriefMailGroup[]
  mailTally?: string
  needsYou?: NeedsYouItem[]
  factLine?: BriefFact[]
  dayScore?: { points: number; verdict: string } | null
  dayFacts?: EveningDayFact[]
  habitsToday?: HabitToday[]
  carryOver?: CarryOverItem[]
  due: BriefDue[]
  later: string[]
  calendarConnected?: boolean
}

/** Chip copy for a scored mail's reasons. */
export function mailReasonLabels(reasons: string[]): string[] {
  const out: string[] = []
  if (reasons.includes('waiting_on_you')) out.push('waiting on you')
  if (reasons.includes('deadline')) out.push('deadline')
  if (reasons.includes('vip_sender')) out.push('you usually reply')
  if (reasons.includes('money')) out.push('money')
  return out
}

/**
 * Mirrors `mailKindPhrase` in deploy/gmailHelpers.ts. Duplicated rather than
 * imported because that module is server code and would pull the Gmail helpers
 * into the client bundle. The five fixed kinds keep their hand-written copy; a
 * kind the judge named for this user arrives singular, so it pluralises here.
 */
export function mailGroupHeading(kind: string, count: number, label: string) {
  if (kind === 'reply') return `${count} to reply`
  if (kind === 'assessment') return count === 1 ? '1 assessment' : `${count} assessments`
  if (kind === 'thanks') return `${count} thanks`
  if (kind === 'money') return count === 1 ? '1 money note' : `${count} money notes`
  if (kind === 'other') return count === 1 ? '1 more' : `${count} more`
  const name = String(label || kind || '').toLowerCase()
  if (!name) return count === 1 ? '1 more' : `${count} more`
  if (count === 1) return `1 ${name}`
  return `${count} ${/(s|x|z|ch|sh)$/.test(name) ? `${name}es` : `${name}s`}`
}

export function firstName(name: string) {
  const w = String(name || '').trim().split(/\s+/)[0]
  return w || name
}

export function isNoiseReminder(text: string) {
  return /daily brief|morning brief|evening brief|^\[(digest|judge|poke)\]/i.test(String(text || ''))
}

export function pickBriefAction(input: {
  hour: number
  lastNightLogged: boolean
  next?: BriefBeat
  due: BriefDue[]
  asks: BriefAsk[]
}): BriefDo {
  if (!input.lastNightLogged && input.hour < 14) {
    return {
      kicker: 'Last night',
      title: 'Log last night',
      hint: 'Bed and wake. Then the day can start.',
      cta: 'Log sleep',
      openKind: 'sleep_tracker',
    }
  }
  if (input.next) {
    const who = firstName(input.next.name)
    return {
      kicker: 'Next',
      title: `${input.next.time}  ${input.next.name}`,
      hint: `Text Alpha prep me for ${who}.`,
      cta: 'Open People',
      openKind: 'networking_crm',
    }
  }
  if (input.due[0]) {
    return {
      kicker: 'Due',
      title: `Ping ${input.due[0].name}`,
      hint: 'They are due a follow up. Text Alpha to send it.',
      cta: 'Open People',
      openKind: 'networking_crm',
    }
  }
  if (input.asks[0]) {
    return {
      kicker: 'Ask',
      title: input.asks[0].label,
      hint: 'Tap it below if you want the thread.',
      cta: 'Keep reading',
      openKind: 'digest',
    }
  }
  return {
    kicker: 'Today',
    title: 'Nothing is on fire',
    hint: 'Text Alpha if you need a prep or a ping.',
    cta: 'Home',
    openKind: 'apps',
  }
}

export function buildBriefLead(input: {
  beats: BriefBeat[]
  due: BriefDue[]
  lastNightHours?: number
  lastNightLogged?: boolean
  calendarConnected?: boolean
}): { lead: string; sub?: string } {
  const next = input.beats[0]
  if (next) return { lead: `${next.name} at ${next.time}` }
  if (input.due[0]) return { lead: `${input.due[0].name} is due` }
  if (input.lastNightLogged && input.lastNightHours) return { lead: `Last night ${input.lastNightHours}h` }
  if (input.calendarConnected === false) return { lead: 'Connect Calendar in Settings' }
  return { lead: 'A quiet day so far' }
}
