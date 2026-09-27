import type { BriefStory } from '../platform/briefStory'
import type { Beat, MailReason, MailThread } from './labData'

/* Turns the live /api/digest payload into the model the brief renders.
 *
 * Everything here is real: senders and subjects come from the mail judge, the
 * schedule from the calendar, the follow-ups from the carry-over list, and the
 * ids are Gmail message ids, which is what makes "open the mail", "draft" and
 * "send" real. The one thing the payload does not carry is the full body, so
 * an opened item asks for the message itself.
 *
 * The client only receives `label`, formatted as "Subject · Sender" by
 * formatMailLineFromParts on the server, so the sender is recovered by
 * splitting on the last separator.
 */

export type DigestPayload = {
  meetings?: Array<{ time: string; title: string; startsInMin?: number }>
  weather?: { temp: number; unit: string; tempC?: number; condition: string; icon?: string }
  mailTally?: string
  mailGroups?: Array<{ kind: string; label: string; count: number; items: Array<{ id: string; label: string; snippet?: string }> }>
  story?: BriefStory
  attention?: { id: string; label: string; snippet?: string; why: string } | null
  calendarConnected?: boolean
}

export type BriefWeather = { temp: number; unit: string; tempC?: number; condition: string; icon?: string }
export type BriefFact = { key: string; text: string; state: 'ok' | 'gap' }

export type BriefSource = {
  beats: Beat[]
  threads: MailThread[]
  paragraph: string
  emailMeta: string
  degraded?: string
  filedLabel?: string
  /** The body lines: sleep, lifts, spend, habits. */
  facts?: BriefFact[]
  weather?: BriefWeather
  /** The shipped brief's lead line ("Last night 7h") and its one hero action. */
  leadLine?: string
  doCard?: { kicker: string; title: string; hint: string; cta: string }
  /** Headline override: the evening closes the day rather than opening it. */
  headline?: { strong: string; soft?: string }
  /** Evening review: takes the schedule slot, because the day is over. */
  review?: {
    score?: { points: number; verdict: string } | null
    facts: Array<{ label: string; detail: string; state: 'done' | 'miss' | 'partial' }>
    habits: Array<{ name: string; emoji: string; done: boolean }>
  }
  scheduleLabel?: string
  emailLabel?: string
}

export function hueOf(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

function splitLabel(label: string): { subject: string; sender: string } {
  const i = label.lastIndexOf(' · ')
  if (i === -1) return { subject: label, sender: '' }
  return { subject: label.slice(0, i).trim(), sender: label.slice(i + 3).trim() }
}

const REASON_LABEL: Record<string, string> = {
  waiting_on_you: 'waiting on you',
  deadline: 'deadline',
  vip_sender: 'you usually reply',
  money: 'money',
  delivery: 'delivery',
}

function reasonsOf(item: { reasons?: string[] }): MailReason[] {
  return (item.reasons ?? []).filter((r): r is MailReason => r in REASON_LABEL)
}

function whyOf(item: { reasons?: string[]; snippet?: string }): string {
  const labels = (item.reasons ?? []).map((r) => REASON_LABEL[r]).filter(Boolean)
  return labels.length ? `It is here because of the ${labels.join(' and ')} signals.` : (item.snippet ?? '').slice(0, 120)
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}

function threadFromItem(
  item: { id: string; label: string; snippet?: string; reasons?: string[] },
  state: MailThread['state'],
  over?: Partial<MailThread>,
): MailThread {
  const { subject, sender } = splitLabel(item.label)
  const name = sender || subject
  const base: MailThread = {
    id: item.id,
    from: { name, email: '', hue: hueOf(name) },
    subject,
    snippet: item.snippet ?? '',
    summary: subject,
    ask: subject,
    why: whyOf(item),
    reasons: reasonsOf(item),
    kind: 'other',
    state,
    arrived: '',
    body: item.snippet ? [item.snippet] : [],
  }
  return { ...base, ...over }
}

/** The whole brief, from the live payload. */
export function digestToBrief(data: DigestPayload | null | undefined): BriefSource {
  const story = data?.story
  const groups = data?.mailGroups ?? []
  const tally = (data?.mailTally ?? '').trim()

  /* Today: the calendar's own meetings win; the story's beats fill the gaps. */
  const beats: Beat[] = (data?.meetings ?? []).map((m, i) => ({
    id: `meet-${i}`,
    time: m.time,
    title: m.title,
    meta: 'On your calendar',
    kind: 'meet' as const,
  }))
  if (beats.length === 0) {
    for (const b of story?.beats ?? []) {
      beats.push({ id: `beat-${b.time}-${b.name}`, time: b.time, title: b.name, meta: 'On your calendar', kind: 'meet' as const })
    }
  }

  /* Need you: the judged mail ranked by its score, then anything in the reply
   * group. Only the top of the ranking becomes *now*: a brief that opens with
   * 28 decisions is an inbox with better manners. The rest is kept, visibly,
   * as lower priority, and rises the moment its score does. */
  const seen = new Set<string>()
  const threads: MailThread[] = []
  const attention = data?.attention ?? null
  const CAP = 5

  const ranked = [...(story?.needsYou ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const replyItems = (groups.find((g) => g.kind === 'reply')?.items ?? []).map((i) => ({ ...i, reasons: ['waiting_on_you'] }))
  const pool = [...ranked, ...replyItems.filter((r) => !ranked.some((n) => n.id === r.id))]
  const pushNow = (item: { id: string; label: string; snippet?: string; reasons?: string[]; why?: string; score?: number }) => {
    if (!item.id || seen.has(item.id)) return
    seen.add(item.id)
    const over: Partial<MailThread> = {}
    if (item.why) over.why = item.why
    threads.push(threadFromItem(item, 'now', over))
  }
  const pushParked = (item: { id: string; label: string; snippet?: string; reasons?: string[]; score?: number }) => {
    if (!item.id || seen.has(item.id)) return
    seen.add(item.id)
    threads.push(
      threadFromItem(item, 'later', {
        filed: { bucket: 'Lower priority', note: `Needs a human, but not today${item.score !== undefined ? ` · score ${item.score}` : ''}` },
      }),
    )
  }
  pool.slice(0, CAP).forEach(pushNow)
  pool.slice(CAP).forEach(pushParked)
  if (attention) {
    const known = threads.find((t) => t.id === attention.id)
    if (known) known.why = attention.why
    else if (needsCount(threads) < CAP) pushNow(attention)
    else pushParked({ ...attention, reasons: [] })
  }

  /* Waiting: the open loops the brief already carries. */
  for (const c of story?.carryOver ?? []) {
    const days = c.dueLabel ? (c.dueLabel.match(/\d+/)?.[0] ?? '') : ''
    threads.push({
      id: `carry-${c.id}`,
      from: { name: c.title, email: '', hue: hueOf(c.title) },
      subject: c.title,
      snippet: '',
      summary: c.title,
      ask: c.title,
      why: 'It is an open loop from an earlier promise.',
      reasons: ['waiting_on_you'],
      kind: 'other',
      state: 'waiting',
      arrived: c.dueLabel ?? '',
      body: [],
      waiting: {
        what: c.title,
        since: c.dueLabel ? `Due ${c.dueLabel}` : 'Still open',
        days: days ? Number(days) : 0,
        expectBy: 'Alpha watches this one',
        overdue: /overdue|past/i.test(c.dueLabel ?? ''),
      },
    })
  }

  /* Filed quietly: every other group, kept with the reason it landed there.
   * Promos and ads are split out entirely: they get their own collapsed pile
   * and are never counted as anything a person sent. */
  const PROMO_KINDS = new Set(['promo', 'newsletter', 'marketing', 'deals', 'offers'])
  const isPromo = (kind: string, label: string) =>
    PROMO_KINDS.has(kind) || /promo|newsletter|deals|offers|marketing/i.test(label)
  for (const group of groups) {
    if (group.kind === 'reply') continue
    const promo = isPromo(group.kind, group.label)
    for (const item of group.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      threads.push(
        threadFromItem(item, 'later', {
          promo,
          filed: promo
            ? { bucket: 'Promos & ads', note: `${group.label} · never interrupts you` }
            : { bucket: group.label, note: `${group.label} · no reply needed` },
        }),
      )
    }
  }

  const needs = threads.filter((t) => t.state === 'now')
  const parked = threads.filter((t) => t.state === 'later')
  const firstName = needs[0] ? firstNameOf(needs[0]) : ''

  const paragraph =
    needs.length === 0
      ? `Nothing needs you. ${tally || 'Everything is filed and nothing is waiting.'}`
      : `Start with ${firstName}. ${needs.length > 1 ? `The other ${needs.length - 1} are kept in lower priority and come back the moment one of them rises. ` : ''}${tally ? `${tally}.` : ''}`

  const emailMeta = tally || `${needs.length} need you · ${parked.length} kept for later`
  /* Same person, one place: reorder so every mail from a sender sits with the
   * rest of that sender's mail, in the order the ranking put them. The brief
   * then renders one card per person. */
  const bySender = new Map<string, MailThread[]>()
  const senderOrder: string[] = []
  for (const t of threads) {
    const key = t.from.name || t.subject
    if (!bySender.has(key)) {
      bySender.set(key, [])
      senderOrder.push(key)
    }
    bySender.get(key)!.push(t)
  }
  const grouped: MailThread[] = []
  for (const key of senderOrder) grouped.push(...bySender.get(key)!)
  threads.splice(0, threads.length, ...grouped)

  const degraded = data?.calendarConnected === false ? 'The calendar is not connected, so today only shows mail.' : undefined

  return {
    beats,
    threads,
    paragraph,
    emailMeta,
    degraded,
    weather: data?.weather,
    facts: story?.factLine ?? [],
    leadLine: story?.lead,
    doCard: story?.do
      ? { kicker: story.do.kicker, title: story.do.title, hint: story.do.hint, cta: story.do.cta }
      : undefined,
    headline: {
      strong: `${needs.length} things need you.`,
      soft: needs.length > 1 ? ` Start with ${firstNameOf(needs[0])}.` : undefined,
    },
    filedLabel: 'lower priority',
  }
}

function firstNameOf(t: MailThread): string {
  return firstName(t.from.name)
}

function needsCount(threads: MailThread[]): number {
  return threads.filter((t) => t.state === 'now').length
}

/** The evening: a review of the day, then what carried over, then the mail that
 *  is still worth answering tonight. Same ids as the morning, so drafts and
 *  sends stay real. */
export function eveningToBrief(e: {
  date?: string
  sections?: Array<{ heading: string; items: string[]; emailMeta?: Array<{ id: string; snippet?: string }> }>
  mailGroups?: Array<{ kind: string; label: string; count: number; items: Array<{ id: string; label: string; snippet?: string }> }>
  dayScore?: { points: number; verdict: string } | null
  dayFacts?: Array<{ key: string; label: string; detail: string; state: 'done' | 'miss' | 'partial' }>
  habitsToday?: Array<{ id: string; name: string; emoji: string; done: boolean }>
  carryOver?: Array<{ id: string; title: string; dueLabel?: string }>
  pending?: boolean
} | null | undefined): BriefSource {
  const groups = e?.mailGroups ?? []
  const threads: MailThread[] = []
  const seen = new Set<string>()

  /* Still worth answering tonight: the mails the sections name, with ids. */
  for (const section of e?.sections ?? []) {
    for (const mail of section.emailMeta ?? []) {
      if (!mail.id || seen.has(mail.id)) continue
      seen.add(mail.id)
      threads.push(
        threadFromItem({ id: mail.id, label: mail.snippet || section.heading, snippet: mail.snippet, reasons: ['waiting_on_you'] }, 'now', {
          ask: mail.snippet || section.heading,
          why: 'It carried over from today.',
        }),
      )
    }
  }

  /* The day's open loops, from the carry-over list. */
  for (const c of e?.carryOver ?? []) {
    if (seen.has(`carry-${c.id}`)) continue
    seen.add(`carry-${c.id}`)
    const days = c.dueLabel?.match(/\d+/)?.[0] ?? ''
    threads.push({
      id: `carry-${c.id}`,
      from: { name: c.title, email: '', hue: hueOf(c.title) },
      subject: c.title,
      snippet: '',
      summary: c.title,
      ask: c.title,
      why: 'It did not close today.',
      reasons: ['waiting_on_you'],
      kind: 'other',
      state: 'now',
      arrived: c.dueLabel ?? '',
      body: [],
      waiting: {
        what: c.title,
        since: c.dueLabel ? `Due ${c.dueLabel}` : 'Carried over',
        days: days ? Number(days) : 0,
        expectBy: 'First thing tomorrow',
        overdue: false,
      },
    })
  }

  /* Everything else the judge sorted: kept, with the reason. */
  for (const group of groups) {
    for (const item of group.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      threads.push(threadFromItem(item, 'later', { filed: { bucket: group.label, note: `${group.label} · no reply needed` } }))
    }
  }

  const facts = e?.dayFacts ?? []
  const habits = e?.habitsToday ?? []
  const landed = facts.filter((f) => f.state === 'done').length
  const carried = (e?.carryOver ?? []).length + threads.filter((t) => t.state === 'now' && t.id.startsWith('mail-') === false).length
  const score = e?.dayScore ?? null

  const paragraph =
    `${landed} of ${facts.length || landed} landed. ` +
    `${carried > 0 ? `${carried} ${carried === 1 ? 'thing carries' : 'things carry'} into tomorrow, and I will put them back in front of you in the morning. ` : 'Nothing is left open. '}` +
    `${score ? `Today scored ${score.points}.` : ''}`.trim()

  return {
    beats: [],
    threads,
    paragraph,
    emailMeta: tallyLine(groups),
    headline: { strong: 'Day closed.', soft: score ? ` ${score.points}. ${score.verdict}` : '' },
    review: { score, facts, habits },
    scheduleLabel: 'How the day went',
    emailLabel: 'Carried over',
  }
}

function tallyLine(groups: Array<{ kind: string; label: string; count: number }>): string {
  return groups.map((g) => `${g.count} ${g.label.toLowerCase()}`).join(', ')
}
