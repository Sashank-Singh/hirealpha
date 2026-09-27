import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlphaFace } from '../AlphaFace'
import { CHIP_LABELS, THREADS, TODAY, TODAY_BEATS, avatarTint, initials, type MailThread, type Tone } from './labData'
import { DRAFT_TONES, TONE_LABEL } from './draftTones'
import { digestToBrief, eveningToBrief, type BriefSource } from './digestBrief'
import { apiDraftMailReply, apiGetMailMessage, apiRewriteDraft, apiSendDraft } from '../platform/api'
import { cleanEmailBody, htmlToText, htmlIsPlainText, renderRichText } from '../platform/mailText'
import './lab.css'
import './emailBrief.css'

/* The brief.
 *
 * Brief, then today, then email, then everything else. Mail is grouped by
 * person: one card per sender, holding every message they sent, each with its
 * own body, draft and send. Promos and ads never appear in the brief; they are
 * their own collapsed pile.
 *
 * Phone first: single column, 44pt targets, safe-area padding, two columns from
 * 900px. /lab/brief runs on mock data; the digest route passes the live payload.
 */

type Status = 'needs' | 'snoozed' | 'waiting' | 'sent' | 'filed' | 'closed'

/** Strips everything active out of a mail's HTML before it is rendered, and
 *  makes every link open outside the app. Same rules as the shipped reader. */
function sanitizeMailHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '<noembed>')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'href="#"')
    .replace(/src\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'src=""')
    .replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ')
}
type Item = { status: Status; note?: string }
type Rule = { id: string; label: string; on: boolean; locked?: boolean }

const RULES: Rule[] = [
  { id: 'file', label: 'File receipts and alerts', on: true },
  { id: 'draft', label: 'Write the reply for me', on: true },
  { id: 'nudge', label: 'Chase after my line', on: true },
  { id: 'send', label: 'Send without my review', on: false, locked: true },
]

const INTERRUPTS = [
  { id: 'deadline', label: 'A deadline inside 48 hours', on: true },
  { id: 'person', label: 'A person waiting on me', on: true },
  { id: 'money', label: 'Anything over $500', on: true },
  { id: 'rest', label: 'Everything else', on: false },
]

/* The lab's own week: deadlines and follow-ups the mock payload knows about.
 * The live payload does not carry dated deadlines yet, so this fold only
 * exists on /lab/brief. */
type Pip = { id: string; day: number; kind: 'deadline' | 'chase' | 'waiting' | 'soft'; title: string; target: string }
const PIPS: Pip[] = [
  { id: 'p1', day: 0, kind: 'deadline', title: 'Interview slot hold, Priya', target: 't1' },
  { id: 'p2', day: 0, kind: 'chase', title: 'Invoice #204, 9 days late', target: 't7' },
  { id: 'p3', day: 0, kind: 'soft', title: 'Marcus is blocked on your yes', target: 't2' },
  { id: 'p4', day: 1, kind: 'waiting', title: 'Recommendation letter', target: 't6' },
  { id: 'p5', day: 1, kind: 'deadline', title: 'Jules books the table', target: 't5' },
  { id: 'p7', day: 2, kind: 'chase', title: 'Figma SLA passed', target: 't9' },
  { id: 'p8', day: 3, kind: 'deadline', title: 'Sarah needs your notes', target: 't4' },
  { id: 'p9', day: 3, kind: 'soft', title: 'Meridian intro going cold', target: 't8' },
  { id: 'p10', day: 7, kind: 'deadline', title: 'Lease signature due', target: 't3' },
]
const DAYS = ['Today', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Next Tue']

/* Where each thread sat before the reader touched it. */
const SEEDED = new Map(THREADS.map((t) => [t.id, t.state]))

const TONE_INSTRUCTION: Record<Tone, string> = {
  plain: 'keep this draft as it is',
  casual: 'make it more casual',
  formal: 'make it more formal',
  shorter: 'make it shorter',
  warmer: 'make it warmer',
}

/* A representative evening payload for the lab preview only. The real one comes
 * from /api/mini?kind=pick_night. */
const SAMPLE_EVENING = {
  date: 'Tuesday, 23 September',
  dayScore: { points: 82, verdict: 'A good day' },
  dayFacts: [
    { key: 'interview', label: 'Interview slot picked', detail: 'Thursday 10:00am, booked with Priya', state: 'done' as const },
    { key: 'invoice', label: 'Invoice #204 chased', detail: 'Firm note sent to Brightline', state: 'done' as const },
    { key: 'lease', label: 'Lease renewal signed', detail: 'The link expires on the 30th', state: 'miss' as const },
    { key: 'run', label: 'Run', detail: 'Went at 6pm instead of 5', state: 'partial' as const },
  ],
  habitsToday: [
    { id: 'h1', name: 'Read 20 pages', emoji: '📖', done: true },
    { id: 'h2', name: 'No coffee after 4', emoji: '☕', done: false },
  ],
  carryOver: [
    { id: 'c1', title: 'Notes on Sarah’s draft', dueLabel: 'Friday' },
    { id: 'c2', title: 'Signature on the lease renewal', dueLabel: 'Sep 30' },
  ],
  sections: [
    {
      heading: 'Worth answering tonight',
      items: ['Priya sent the interview loop details.'],
      emailMeta: [{ id: 't1', snippet: 'She attached the loop outline and the panel names.' }],
    },
  ],
  mailGroups: [
    {
      kind: 'other',
      label: 'Filed',
      count: 6,
      items: [
        { id: 't10', label: 'Your receipt from Figma · Figma', snippet: 'Receipt for your Figma subscription, $18.00.' },
        { id: 't12', label: 'The quiet unbundling of the vertical SaaS stack · The Diff', snippet: 'This week: why the mid market is buying point solutions again.' },
      ],
    },
  ],
}

/** The digest route renders this: the live payload becomes the model, a refresh
 *  rebuilds it while drafts the reader has touched stay put, and the header
 *  chip shows when it was built with a button to force a fresh build. */
export function NextBriefEmbedded({
  data,
  updatedAt = 0,
  refreshing = false,
  onRefresh,
}: {
  data: unknown
  updatedAt?: number
  refreshing?: boolean
  onRefresh?: () => Promise<void>
}) {
  const [source, setSource] = useState(() => digestToBrief(data as never))
  const [seen, setSeen] = useState(data)
  if (data !== seen) {
    setSeen(data)
    setSource(digestToBrief(data as never))
  }
  return <EmailBrief embedded source={source} updatedAt={updatedAt} refreshing={refreshing} onRefresh={onRefresh} />
}

/** Lab preview of the refresh chip: the button spins while the fetch runs and
 *  the timestamp only moves when a real payload lands. */
function RefreshPreview() {
  const [busy, setBusy] = useState(false)
  return (
    <EmailBrief
      updatedAt={Date.now() - 41 * 60 * 1000}
      refreshing={busy}
      onRefresh={() => {
        setBusy(true)
        return new Promise<void>((r) => setTimeout(() => { setBusy(false); r() }, 1200))
      }}
    />
  )
}

/** The evening route renders this: the review payload becomes the model. */
export function NextBriefEvening({ evening }: { evening: unknown }) {
  const [source, setSource] = useState(() => eveningToBrief(evening as never))
  const [seen, setSeen] = useState(evening)
  if (evening !== seen) {
    setSeen(evening)
    setSource(eveningToBrief(evening as never))
  }
  return <EmailBrief embedded source={source} />
}

/** Lab preview: the embedded variant inside a copy of the mini shell, so the
 *  integration can be reviewed without signing in. Open /lab/brief?embed=1,
 *  /lab/brief?embed=1&evening=1 for the evening. */
export function EmailBriefPage() {
  const [params] = useSearchParams()
  if (params.has('evening')) return <NextBriefEvening evening={SAMPLE_EVENING} />
  if (params.has('refresh')) return <RefreshPreview />
  if (!params.has('embed')) return <EmailBrief />
  return (
    <div className="mini">
      <header className="mini__head">
        <a className="mini__nav" href="/lab/brief" aria-label="Back">
          <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
            <path d="M14 4l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
        <span className="mini__avatar">
          <AlphaFace color="#2a6f7a" mood="soft" size={42} />
        </span>
        <span className="mini__who">
          <h1 className="mini__name">Alpha</h1>
          <p className="mini__role">Personal Assistant</p>
        </span>
        <span className="mini__brand">HireAlpha</span>
      </header>
      <div className="mini__body">
        <EmailBrief embedded />
      </div>
    </div>
  )
}

/** `embedded` renders inside the mini app shell: the shell already provides the
 *  identity header, the column width and the page padding, so the brief drops
 *  its own topbar and gutters and lets the shell lead. */
export function EmailBrief({
  embedded = false,
  source,
  updatedAt = 0,
  refreshing = false,
  onRefresh,
}: {
  embedded?: boolean
  source?: BriefSource
  updatedAt?: number
  refreshing?: boolean
  onRefresh?: () => Promise<void>
} = {}) {
  const [items, setItems] = useState<Record<string, Item>>({})
  /* Undefined means "not touched yet", which defaults to the first card being
   * open. Null means the reader closed it. */
  const [open, setOpen] = useState<string | null | undefined>(undefined)
  const [mailIn, setMailIn] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [asks, setAsks] = useState<Record<string, string>>({})
  const [adjust, setAdjust] = useState<Record<string, boolean>>({})
  const [toneMap, setToneMap] = useState<Record<string, Tone>>({})
  const [defaultTone, setDefaultTone] = useState<Tone>('plain')
  const [menu, setMenu] = useState<string | null>(null)
  const [openBeat, setOpenBeat] = useState<string | null>(null)
  const [prepped, setPrepped] = useState<string[]>([])
  const [weekOpen, setWeekOpen] = useState(false)
  const [rules, setRules] = useState<Rule[]>(RULES)
  const [interrupts, setInterrupts] = useState(INTERRUPTS)
  const [filter, setFilter] = useState<'needs' | 'waiting' | 'filed'>('needs')
  const [promosOpen, setPromosOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null)
  const [spin, setSpin] = useState(false)
  /* Live mode only: the stored draft's to/subject, fetched bodies, and the
   * two tap confirm that stands between a tap and a real send. */
  const [live, setLive] = useState<{
    meta: Record<string, { toAddr: string; subject: string }>
    bodies: Record<string, { html: string; paras: string[] }>
    busy: Record<string, 'drafting' | 'recutting' | 'sending' | 'reading'>
    confirm: string | null
  }>({ meta: {}, bodies: {}, busy: {}, confirm: null })

  const isLive = !!source
  const model = source ?? {
    beats: TODAY_BEATS,
    threads: THREADS,
    paragraph: '',
    emailMeta: '',
    weather: { temp: 64, unit: 'F', tempC: 18, condition: 'Clear', icon: '☀️' },
    facts: [
      { key: 'sleep', state: 'ok', text: 'You slept 7h 24m' },
      { key: 'lifts', state: 'ok', text: '3 lifts this week' },
      { key: 'spend', state: 'ok', text: '$212 of $400 spent' },
      { key: 'habits', state: 'ok', text: '6 day habit best' },
    ],
    leadLine: 'Priya Raman at 9:30am',
    doCard: { kicker: 'Next', title: 'Priya Raman at 9:30am', hint: 'Show up ready.', cta: 'Prep me' },
  }
  const status = (id: string): Status =>
    items[id]?.status ?? (SEEDED.get(id) === 'waiting' ? 'waiting' : SEEDED.get(id) === 'later' ? 'filed' : 'needs')

  const needs = model.threads.filter((t) => ['needs', 'snoozed'].includes(status(t.id)))
  /* 'sent' means you replied and the ball is with them: the same job for the
   * reader as a thread Alpha is already chasing. */
  const watching = model.threads.filter((t) => ['waiting', 'sent'].includes(status(t.id)))
  const filed = model.threads.filter((t) => ['filed', 'closed'].includes(status(t.id)) && !t.promo)
  const promos = model.threads.filter((t) => t.promo)
  const listed = filter === 'needs' ? needs : filter === 'waiting' ? watching : filed

  /* One card per person: the converter has already parked same-sender mail
   * together, so the groups are runs of that name in the filtered list. */
  const groups: { key: string; name: string; hue: number; mails: MailThread[] }[] = []
  for (const t of listed) {
    const last = groups[groups.length - 1]
    if (last && last.name === t.from.name) last.mails.push(t)
    else groups.push({ key: t.id, name: t.from.name, hue: t.from.hue, mails: [t] })
  }
  const promoGroups: { key: string; name: string; mails: MailThread[] }[] = []
  for (const t of promos) {
    const last = promoGroups[promoGroups.length - 1]
    if (last && last.name === t.from.name) last.mails.push(t)
    else promoGroups.push({ key: t.id, name: t.from.name, mails: [t] })
  }

  function flash(text: string, undo: () => void) {
    setToast({ text, undo })
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 8000)
  }

  function setStatus(id: string, next: Status, note?: string) {
    const before = items[id]
    setItems((prev) => ({ ...prev, [id]: { status: next, note } }))
    return () =>
      setItems((prev) => {
        const copy = { ...prev }
        if (before) copy[id] = before
        else delete copy[id]
        return copy
      })
  }

  /* Undo puts the thread back where it was and reopens it, so the reversal is
   * visible rather than silent. */
  function send(t: MailThread) {
    const restore = setStatus(t.id, 'sent', 'You replied. Watching for an answer.')
    setOpen(null)
    setMenu(null)
    flash(`Sent to ${t.from.name.split(' ')[0]}. I will chase if nothing comes back.`, () => {
      restore()
      setFilter('needs')
      setOpen(t.id)
    })
  }

  function snooze(t: MailThread) {
    const undo = setStatus(t.id, 'snoozed', 'Snoozed to 4pm')
    setMenu(null)
    flash('Back at 4pm, once.', undo)
  }

  function file(t: MailThread) {
    const undo = setStatus(t.id, 'filed', 'You filed it')
    setOpen(null)
    setMenu(null)
    flash('Filed. Pull it back for seven days.', undo)
  }

  function bringBack(t: MailThread) {
    const undo = setStatus(t.id, 'needs', 'You pulled it back')
    setFilter('needs')
    setOpen(t.id)
    flash('Back in the brief.', undo)
  }

  function nudge(t: MailThread) {
    const undo = setStatus(t.id, 'waiting', 'Nudged. Checking Thursday.')
    setMenu(null)
    flash(`Nudge sent to ${t.from.name.split(' ')[0]}.`, undo)
  }

  function closeLoop(t: MailThread) {
    const undo = setStatus(t.id, 'closed', 'Closed, nothing to chase')
    setMenu(null)
    flash('Closed.', undo)
  }

  function jump(target: string) {
    const t = model.threads.find((x) => x.id === target)
    if (!t) return
    const s = status(t.id)
    setFilter(s === 'waiting' || s === 'sent' ? 'waiting' : s === 'filed' || s === 'closed' ? 'filed' : 'needs')
    const groupKey = model.threads.find((x) => x.from.name === t.from.name && status(x.id) === s)?.id ?? t.id
    setOpen(groupKey)
    setMailIn((m) => ({ ...m, [groupKey]: t.id }))
    window.setTimeout(() => document.getElementById(`item-${groupKey}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }

  const ruleOn = (id: string) => rules.find((r) => r.id === id)?.on ?? false
  const busyOf = (id: string): string | undefined => (isLive ? live.busy[id] : undefined)
  const clearBusy = (id: string) =>
    setLive((s) => {
      const busy = { ...s.busy }
      delete busy[id]
      return { ...s, busy }
    })
  /** What the reader sees: real HTML when the mail was formatted, rich text
   *  when it was plain, and the lab paragraphs for mock mail. */
  function displayOf(t: MailThread): { html: string; paras: string[] } {
    const liveBody = live.bodies[t.id]
    if (liveBody) return liveBody
    if (t.htmlBody) return { html: sanitizeMailHtml(t.htmlBody), paras: [] }
    return { html: '', paras: t.body }
  }
  const draftBody = (t: MailThread): string => drafts[t.id] ?? t.draft?.body ?? t.nudge?.body ?? ''
  const toneOf = (id: string): Tone => toneMap[id] ?? defaultTone

  /** Opening a live item fetches the real message: sender, subject and body. */
  async function openLive(t: MailThread) {
    if (!isLive || live.bodies[t.id] || live.busy[t.id] === 'reading') return
    setLive((s0) => ({ ...s0, busy: { ...s0.busy, [t.id]: 'reading' } }))
    try {
      const msg = await apiGetMailMessage({ messageId: t.id })
      if (msg.ok) {
        /* Rendered exactly as the reader would: formatted mail keeps its HTML
         * (images, links, lists), plain mail gets its text lifted into links
         * and paragraphs. */
        const richHtml = msg.bodyHtml && !htmlIsPlainText(msg.bodyHtml) ? sanitizeMailHtml(msg.bodyHtml) : ''
        const plainText = cleanEmailBody(msg.bodyText || htmlToText(msg.bodyHtml || '') || cleanEmailBody(msg.snippet || t.snippet))
        const body = richHtml
          ? { html: richHtml, paras: [] as string[] }
          : { html: renderRichText(plainText || 'No content in this mail.'), paras: [plainText || 'No content in this mail.'] }
        setLive((s0) => {
          const meta = { ...s0.meta }
          if (msg.subject) meta[t.id] = { ...(meta[t.id] ?? { toAddr: '', subject: '' }), subject: msg.subject }
          const busy = { ...s0.busy }
          delete busy[t.id]
          return { ...s0, bodies: { ...s0.bodies, [t.id]: body }, meta, busy }
        })
      } else {
        clearBusy(t.id)
      }
    } catch {
      clearBusy(t.id)
    }
  }

  /** Asks Alpha for the draft. The response may arrive without a body, in
   *  which case one recut brings the text back with it. */
  async function requestLiveDraft(t: MailThread) {
    setLive((s0) => ({ ...s0, busy: { ...s0.busy, [t.id]: 'drafting' } }))
    try {
      const res = await apiDraftMailReply({ id: t.id })
      if (!res.ok) throw new Error(res.error || 'Alpha could not write that right now.')
      setLive((s0) => ({ ...s0, meta: { ...s0.meta, [t.id]: { toAddr: res.toAddr || '', subject: res.subject || t.subject } } }))
      if (res.body) {
        setDrafts((d) => ({ ...d, [t.id]: res.body as string }))
        clearBusy(t.id)
        return
      }
      const recut = await apiRewriteDraft({ id: t.id, instruction: TONE_INSTRUCTION.plain })
      setDrafts((d) => ({ ...d, [t.id]: recut.body || '' }))
      clearBusy(t.id)
    } catch (err) {
      clearBusy(t.id)
      flash(err instanceof Error ? err.message : 'Could not write the draft.', () => undefined)
    }
  }

  /** A voice tap is a real recut through Alpha, so the chips wait for it. */
  async function recutLive(t: MailThread, tone: Tone) {
    setLive((s0) => ({ ...s0, busy: { ...s0.busy, [t.id]: 'recutting' } }))
    try {
      const res = await apiRewriteDraft({ id: t.id, instruction: TONE_INSTRUCTION[tone] })
      if (!res.ok) throw new Error(res.error || 'Alpha could not recut that right now.')
      setDrafts((d) => ({ ...d, [t.id]: res.body || '' }))
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not recut the draft.', () => undefined)
    } finally {
      clearBusy(t.id)
    }
  }

  /** Sending is a real send, so it asks twice. */
  async function sendLive(t: MailThread) {
    const meta = live.meta[t.id]
    if (!meta?.toAddr) {
      flash('Alpha could not work out the address for this one. Reply from the thread instead.', () => undefined)
      return
    }
    setLive((s0) => ({ ...s0, busy: { ...s0.busy, [t.id]: 'sending' } }))
    try {
      const res = await apiSendDraft({ id: t.id, toAddr: meta.toAddr, subject: meta.subject || t.subject, body: drafts[t.id] ?? '' })
      if (!res.ok) throw new Error(res.error || 'Send failed.')
      setStatus(t.id, 'sent', 'You replied. Watching for an answer.')
      clearBusy(t.id)
      setLive((s0) => ({ ...s0, confirm: null }))
      setOpen(null)
      flash(`Sent to ${t.from.name.split(' ')[0]}. I will chase if nothing comes back.`, () => setStatus(t.id, 'needs'))
    } catch (err) {
      clearBusy(t.id)
      setLive((s0) => ({ ...s0, confirm: null }))
      flash(err instanceof Error ? err.message : 'Send failed.', () => undefined)
    }
  }

  /** One tap, no typing: the whole draft is re cut in that voice. */
  function applyTone(t: MailThread, tone: Tone) {
    setToneMap((prev) => ({ ...prev, [t.id]: tone }))
    setDrafts((prev) => {
      const next = { ...prev }
      const variant = tone === 'plain' ? undefined : DRAFT_TONES[t.id]?.[tone]
      if (variant) next[t.id] = variant
      else delete next[t.id]
      return next
    })
  }

  /** Changing the default re cuts every draft the reader has not spoken for. */
  function applyDefaultTone(tone: Tone) {
    setDefaultTone(tone)
    setToneMap((prev) => prev)
    setDrafts((prev) => {
      const next = { ...prev }
      for (const th of model.threads) {
        if (toneMap[th.id]) continue
        const variant = tone === 'plain' ? undefined : DRAFT_TONES[th.id]?.[tone]
        if (variant) next[th.id] = variant
        else delete next[th.id]
      }
      return next
    })
  }

  /** A typed instruction goes through the same machinery as the chips: name a
   *  voice and the whole draft is re cut, otherwise match an angle or fall back
   *  to a small, stated change. */
  function applyRewrite(t: MailThread) {
    const instruction = asks[t.id]?.trim()
    if (!instruction) return
    const lower = instruction.toLowerCase()
    setAsks((a) => ({ ...a, [t.id]: '' }))

    const voice = (['formal', 'casual', 'shorter', 'warmer'] as Tone[]).find((tone) => lower.includes(tone))
    if (voice && DRAFT_TONES[t.id]?.[voice]) {
      applyTone(t, voice)
      return
    }
    if (/question|ask/.test(lower)) {
      setDrafts((d) => ({ ...d, [t.id]: `${draftBody(t)}\n\nOne question before then: is there anything you want me to prepare?` }))
      return
    }
    setDrafts((d) => ({ ...d, [t.id]: draftBody(t).replace(/^(Hi [^,\n]+,\n)/, '$1\nThanks for the note.\n') }))
  }

  const pips = PIPS.filter((p) => !['filed', 'closed'].includes(status(p.target)))

  const rulesOn = rules.filter((r) => r.on).length
  const interrupted = interrupts.filter((i) => i.on).length

  /** What happens if the reader does nothing, recomputed from the live rules
   *  so the switches visibly change the deal. */
  function autoLine(t: MailThread): string {
    if (t.reasons.includes('money') || t.kind === 'money') {
      return ruleOn('send') ? 'I may settle this alone.' : 'I will not touch money without you.'
    }
    if (t.deadline) return ruleOn('nudge') ? `I bring it back ${t.deadline.when}, once.` : 'I let it close.'
    if (t.from.vip) return 'Left for you.'
    return ruleOn('draft') ? 'Draft stays ready. Nothing sends.' : 'Left for you.'
  }

  /** The morning paragraph, derived from whatever the mailbox actually is. */
  function briefParagraph(): string {
    if (source?.paragraph) return source.paragraph
    const filedLine = `I filed ${filed.length} overnight and ${watching.length} replies are still out with other people.`
    if (needs.length === 0) return `Nothing needs you. ${filedLine}`
    const clock = needs.find((t) => t.deadline)
    if (!clock) return `${needs.length} things need you and none of them are urgent. ${filedLine}`
    const others = needs.length - 1
    const rest = others === 0 ? 'Nothing else needs you.' : `The other ${others} can wait until lunch.`
    return `${clock.from.name.split(' ')[0]} is the one with a clock on it. ${rest} ${filedLine}`
  }

  return (
    <div className={`lab lb${embedded ? ' lb-embedded' : ''}`}>
      <div className="lab-shell">
        {!embedded && (
          <header className="lab-topbar">
            <AlphaFace color="#2a6f7a" mood="soft" size={30} />
            <div className="lab-brand">
              <div className="lab-brand__name">Alpha</div>
              <div className="lab-brand__role">Morning brief · {TODAY}</div>
            </div>
            <button
              type="button"
              className="lb-gear"
              aria-label="Alpha's rules"
              aria-expanded={settingsOpen}
              onClick={() => {
                setSettingsOpen(true)
                window.setTimeout(() => document.getElementById('lb-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
              }}
            >
              <svg viewBox="0 0 20 20" width="19" height="19" aria-hidden="true">
                <circle cx="10" cy="10" r="2.9" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <circle cx="10" cy="3.4" r="1.5" fill="currentColor" />
                <circle cx="10" cy="16.6" r="1.5" fill="currentColor" />
                <circle cx="3.4" cy="10" r="1.5" fill="currentColor" />
                <circle cx="16.6" cy="10" r="1.5" fill="currentColor" />
              </svg>
            </button>
          </header>
        )}

        <section className="lb-lead">
          {model.leadLine && <p className="lb-lead__line">{model.leadLine}</p>}
          <h1 className="lab-display lb-lead__title">
            {source?.headline ? (
              <>
                {source.headline.strong}
                {source.headline.soft && <span className="lb-lead__soft">{source.headline.soft}</span>}
              </>
            ) : (
              <>
                {needs.length} things need you.
                <span className="lb-lead__soft"> One has a clock on it.</span>
              </>
            )}
          </h1>
          <p className="lb-lead__para">{briefParagraph()}</p>
          {(model.weather || (model.facts?.length ?? 0) > 0) && (
            <div className="lb-factline">
              {model.weather && (
                <span className="lb-factchip lb-factchip--weather" title={model.weather.condition}>
                  <span aria-hidden="true">{model.weather.icon || '🌤️'}</span>
                  {model.weather.temp}°{model.weather.unit === 'C' ? 'C' : 'F'}
                  <span className="lb-factchip__cond">{model.weather.condition}</span>
                </span>
              )}
              {(model.facts ?? []).map((f) => (
                <span key={f.key} className={`lb-factchip${f.state === 'gap' ? ' is-gap' : ''}`}>
                  {f.text}
                </span>
              ))}
            </div>
          )}
        </section>

        {model.doCard && (
          <section className="lb-do">
            <span className="lab-kicker">{model.doCard.kicker}</span>
            <div className="lb-do__row">
              <div className="lb-do__id">
                <span className="lb-do__title">{model.doCard.title}</span>
                <span className="lb-do__hint">{model.doCard.hint}</span>
              </div>
              <button type="button" className="lab-btn" onClick={() => flash(`${model.doCard?.cta ?? 'Opening'} — opening in chat.`, () => undefined)}>
                {model.doCard?.cta ?? 'Open'}
              </button>
            </div>
          </section>
        )}

        <section className="lb-schedule">
          <div className="lb-head">
            <span className="lab-kicker">{source?.scheduleLabel ?? 'Today'}</span>
            <span className="lb-head__meta lab-num">
              {source?.review
                ? source.review.score
                  ? `${source.review.score.points} · ${source.review.score.verdict}`
                  : 'The day, in review'
                : model.beats.length
                  ? `${model.beats.length} events · next at ${model.beats[0]?.time}`
                  : 'Nothing scheduled'}
            </span>
          </div>
          {source?.review && (
            <div className="lb-review lab-fade-in">
              {source.review.facts.map((f) => (
                <div key={f.label} className={`lb-fact is-${f.state}`}>
                  <span className="lb-fact__mark" aria-hidden="true">
                    {f.state === 'done' ? 'Yes' : f.state === 'miss' ? 'No' : 'Part'}
                  </span>
                  <span className="lb-fact__id">
                    <span className="lb-fact__label">{f.label}</span>
                    <span className="lb-fact__detail">{f.detail}</span>
                  </span>
                </div>
              ))}
              {source.review.habits.length > 0 && (
                <div className="lb-habits">
                  {source.review.habits.map((h) => (
                    <span key={h.name} className={`lab-chip${h.done ? ' lab-chip--accent' : ' lab-chip--plain'}`}>
                      {h.emoji} {h.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {!source?.review && (
            <ul className="lb-beats">
              {model.beats.length === 0 && (
                <li className="lb-beat lb-beat__empty">
                  <span className="lb-beat__title">Nothing on the calendar for the rest of today.</span>
                  <span className="lb-beat__meta">If something lands, I will tell you only if it matches your switches.</span>
                </li>
              )}
              {model.beats.map((b, i) => {
                const isOpen = openBeat === b.id
                const isPrepped = prepped.includes(b.id)
                const linked = b.threadId ? model.threads.find((t) => t.id === b.threadId) : undefined
                return (
                  <li key={b.id} className={`lb-beat is-${b.kind}${isOpen ? ' is-open' : ''}`}>
                    <button
                      type="button"
                      className="lb-beat__head"
                      aria-expanded={isOpen}
                      onClick={() => setOpenBeat(isOpen ? null : b.id)}
                    >
                      <span className="lb-beat__time lab-num">{b.time}</span>
                      <span className="lb-beat__id">
                        <span className="lb-beat__title">{b.title}</span>
                        <span className="lb-beat__meta">{b.meta}</span>
                      </span>
                      {i === 0 && !isPrepped && <span className="lab-chip lab-chip--accent">next</span>}
                      {isPrepped && <span className="lab-chip lab-chip--plain">prepped</span>}
                    </button>
                    {isOpen && (
                      <div className="lb-beat__body lab-fade-in">
                        {b.note && <p className="lb-beat__note">{b.note}</p>}
                        <div className="lb-actions">
                          <button
                            type="button"
                            className="lab-btn lab-btn--primary lab-btn--full"
                            disabled={isPrepped}
                            onClick={() => {
                              setPrepped((prev) => [...prev, b.id])
                              flash(`Prep sheet for ${b.title} is ready in chat.`, () => setPrepped((prev) => prev.filter((x) => x !== b.id)))
                            }}
                          >
                            {isPrepped ? 'Prep sheet ready' : 'Prep me'}
                          </button>
                          {linked && (
                            <button type="button" className="lb-chip" onClick={() => jump(linked.id)}>
                              From {linked.from.name.split(' ')[0]}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <div className="lb-head lb-head--section">
          <span className="lab-kicker">{source?.emailLabel ?? 'Email'}</span>
          <span className="lb-head__right">
            {onRefresh && (
              <button
                type="button"
                className={`lb-refresh${spin || refreshing ? ' is-busy' : ''}`}
                onClick={() => {
                  setSpin(true)
                  void Promise.resolve(onRefresh()).finally(() => setSpin(false))
                }}
                disabled={spin || refreshing}
              >
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className={`lb-refresh__icon${spin || refreshing ? ' is-spinning' : ''}`}>
                  <path
                    d="M13.3 8a5.3 5.3 0 1 1-1.55-3.75M13.3 1.6v3h-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="lab-num">
                  {spin || refreshing ? 'Refreshing' : updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Update'}
                </span>
              </button>
            )}
            <span className="lb-head__meta lab-num">{source?.emailMeta || `31 read · ${needs.length} need you`}</span>
          </span>
        </div>

        <nav className="lb-tally" aria-label="Sections">
          {([
            ['needs', needs.length, 'need you'],
            ['waiting', watching.length, 'waiting on others'],
            ['filed', filed.length, source?.filedLabel ?? 'filed quietly'],
          ] as const).map(([key, count, label]) => (
            <button
              key={key}
              type="button"
              className={`lb-tally__btn${filter === key ? ' is-active' : ''}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              <span className="lab-num lb-tally__n">{count}</span>
              <span className="lb-tally__label">{label}</span>
            </button>
          ))}
        </nav>

        <div className="lb-body">
          <main className="lb-main">
            <div className="lb-list">
              {groups.map((group) => {
                const groupKey = group.mails[0].id
                const firstKey = groups[0]?.key ?? null
                const isOpen = open === groupKey || (open === undefined && groupKey === firstKey)
                const top = group.mails[0]
                const many = group.mails.length > 1
                const sent = group.mails.some((m) => items[m.id]?.status === 'sent')
                const activeMail = mailIn[groupKey] ?? group.mails[0].id
                return (
                  <article key={groupKey} id={`item-${groupKey}`} className={`lb-item${isOpen ? ' is-open' : ''}`}>
                    <button
                      type="button"
                      className="lb-item__head"
                      aria-expanded={isOpen}
                      onClick={() => {
                        setOpen(isOpen ? null : groupKey)
                        setMenu(null)
                        if (!isOpen) void openLive(group.mails[0])
                      }}
                      key={'head-' + groupKey}
                    >
                      <span className="lab-avatar lab-avatar--sm" style={{ background: avatarTint(top.from.hue).bg, color: avatarTint(top.from.hue).fg }}>
                        {initials(top.from.name)}
                      </span>
                      <span className="lb-item__id">
                        <span className="lb-item__who">
                          {top.from.name}
                          {many && <span className="lb-item__org lab-num">{group.mails.length} mails</span>}
                          <span className="lb-item__time lab-num">{sent ? 'sent' : top.arrived}</span>
                        </span>
                        <span className="lb-item__ask">{items[top.id]?.note ?? top.ask ?? top.waiting?.what ?? top.summary}</span>
                      </span>
                      <span className="lb-item__flag">
                        {items[top.id]?.status === 'snoozed' ? (
                          <span className="lab-chip lab-chip--quiet">4pm</span>
                        ) : top.waiting?.overdue ? (
                          <span className="lab-chip lab-chip--risk lab-num">{top.waiting.days}d</span>
                        ) : top.deadline ? (
                          <span className="lab-chip lab-chip--now lab-num">{top.deadline.when}</span>
                        ) : top.filed ? (
                          <span className="lab-chip lab-chip--plain">{top.filed.bucket}</span>
                        ) : null}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="lb-item__body lab-fade-in">
                        {group.mails.map((t) => {
                          const isMailOpen = !many || activeMail === t.id
                          const busy = busyOf(t.id)
                          return (
                            <div key={t.id} className={`lb-mailblock${isMailOpen ? ' is-open' : ''}`}>
                              {many && (
                                <button
                                  type="button"
                                  className="lb-mailblock__head"
                                  onClick={() => {
                                    setMailIn((m) => ({ ...m, [groupKey]: t.id }))
                                    if (!isMailOpen) void openLive(t)
                                  }}
                                >
                                  <span className="lb-mailblock__subj">{live.meta[t.id]?.subject || t.subject}</span>
                                  <span className="lab-note lab-num">{t.arrived}</span>
                                </button>
                              )}
                              {isMailOpen && (
                                <>
                                  <div className="lb-mail">
                                    <div className="lb-mail__meta">
                                      <span className="lb-mail__subj">{live.meta[t.id]?.subject || t.subject}</span>
                                      <span className="lb-mail__from">{t.from.name}</span>
                                    </div>
                                    {(() => {
                                      const shown = displayOf(t)
                                      if (shown.html) {
                                        return (
                                          <div
                                            className="lb-mail__html"
                                            // The html is sanitized above: scripts, handlers and
                                            // javascript urls are gone, links open outside.
                                            dangerouslySetInnerHTML={{ __html: shown.html }}
                                          />
                                        )
                                      }
                                      return (
                                        <div
                                          className="lb-mail__html lb-mail__html--text"
                                          dangerouslySetInnerHTML={{
                                            __html: renderRichText(shown.paras.join('\n\n') || t.snippet || ''),
                                          }}
                                        />
                                      )
                                    })()}
                                    {t.attachments && (
                                      <ul className="lb-files">
                                        {t.attachments.map((f) => (
                                          <li key={f.name}>
                                            <span className="lb-files__name">{f.name}</span>
                                            <span className="lab-note">{f.meta}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>

                                  <div className="lb-read">
                                    <div className="lb-read__row">
                                      <span className="lb-read__chips">
                                        {t.reasons.slice(0, 2).map((r) => (
                                          <span
                                            key={r}
                                            className={`lab-chip${r === 'money' ? ' lab-chip--risk' : r === 'deadline' ? ' lab-chip--now' : ' lab-chip--plain'}`}
                                          >
                                            {CHIP_LABELS[r]}
                                          </span>
                                        ))}
                                      </span>
                                    </div>
                                    <p className="lb-read__auto">{autoLine(t)}</p>
                                    <p className="lb-read__why">{t.why}</p>
                                  </div>

                                  {(t.draft || t.nudge) && (
                                    <div className="lb-draft">
                                      <div className="lb-draft__to">
                                        {isLive
                                          ? `To ${live.meta[t.id]?.toAddr || '…'}`
                                          : t.draft
                                            ? `To ${t.from.email}`
                                            : `Nudge · ${t.from.email}`}
                                        {toneOf(t.id) !== 'plain' && (
                                          <span className="lb-draft__tone"> · {TONE_LABEL[toneOf(t.id)].toLowerCase()}</span>
                                        )}
                                      </div>
                                      <textarea
                                        className="lb-draft__text"
                                        aria-label={t.draft ? `Reply to ${t.from.name}` : `Nudge ${t.from.name}`}
                                        value={draftBody(t)}
                                        onChange={(e) => {
                                          setDrafts((d) => ({ ...d, [t.id]: e.target.value }))
                                          if (live.confirm === t.id) setLive((s0) => ({ ...s0, confirm: null }))
                                        }}
                                      />
                                      <div className="lb-tones">
                                        <button
                                          type="button"
                                          className={`lb-adjust__toggle${adjust[t.id] ? ' is-open' : ''}`}
                                          aria-expanded={!!adjust[t.id]}
                                          onClick={() => setAdjust((a) => ({ ...a, [t.id]: !a[t.id] }))}
                                        >
                                          <span className="lb-adjust__word">Adjust</span>
                                          {toneOf(t.id) !== 'plain' && <span className="lb-adjust__voice">{TONE_LABEL[toneOf(t.id)].toLowerCase()}</span>}
                                          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                                            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                                          </svg>
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {adjust[t.id] && (
                                    <div className="lb-adjust__panel lab-fade-in">
                                      <div className="lb-adjust__voices">
                                        {(['casual', 'formal', 'shorter', 'warmer'] as Tone[]).map((tone) => {
                                          const active = toneOf(t.id) === tone
                                          return (
                                            <button
                                              key={tone}
                                              type="button"
                                              className={`lb-chip lb-chip--tone${active ? ' is-active' : ''}`}
                                              aria-pressed={active}
                                              disabled={busy === 'recutting'}
                                              onClick={() => (isLive ? void recutLive(t, tone) : applyTone(t, tone))}
                                            >
                                              {busy === 'recutting' ? `${TONE_LABEL[tone]}…` : TONE_LABEL[tone]}
                                            </button>
                                          )
                                        })}
                                        {toneOf(t.id) !== 'plain' && (
                                          <button type="button" className="lb-chip" onClick={() => applyTone(t, 'plain')}>
                                            Original
                                          </button>
                                        )}
                                      </div>
                                      <div className="lb-adjust__ask">
                                        <input
                                          className="lb-adjust__input"
                                          placeholder="Or tell Alpha what to change"
                                          aria-label="Tell Alpha what to change"
                                          value={asks[t.id] ?? ''}
                                          onChange={(e) => setAsks((a) => ({ ...a, [t.id]: e.target.value }))}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                              e.preventDefault()
                                              applyRewrite(t)
                                            }
                                          }}
                                        />
                                        <button type="button" className="lb-chip" disabled={!(asks[t.id] ?? '').trim()} onClick={() => applyRewrite(t)}>
                                          Apply
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  <div className="lb-actions">
                                    {isLive && (status(t.id) === 'needs' || status(t.id) === 'snoozed') ? (
                                      live.meta[t.id] || drafts[t.id] ? (
                                        live.confirm === t.id ? (
                                          <button
                                            type="button"
                                            className="lab-btn lab-btn--primary lab-btn--full"
                                            disabled={busy === 'sending'}
                                            onClick={() => void sendLive(t)}
                                          >
                                            {busy === 'sending' ? 'Sending…' : `Really send to ${t.from.name.split(' ')[0]}?`}
                                          </button>
                                        ) : (
                                          <button type="button" className="lab-btn lab-btn--primary lab-btn--full" onClick={() => setLive((s0) => ({ ...s0, confirm: t.id }))}>
                                            Send reply
                                          </button>
                                        )
                                      ) : (
                                        <button
                                          type="button"
                                          className="lab-btn lab-btn--primary lab-btn--full"
                                          disabled={busy === 'drafting'}
                                          onClick={() => void requestLiveDraft(t)}
                                        >
                                          {busy === 'drafting' ? 'Writing…' : 'Draft reply'}
                                        </button>
                                      )
                                    ) : status(t.id) === 'waiting' || status(t.id) === 'sent' ? (
                                      <button type="button" className="lab-btn lab-btn--primary lab-btn--full" onClick={() => nudge(t)}>
                                        Send nudge
                                      </button>
                                    ) : status(t.id) === 'filed' || status(t.id) === 'closed' ? (
                                      <button type="button" className="lab-btn lab-btn--primary lab-btn--full" onClick={() => bringBack(t)}>
                                        Bring it back
                                      </button>
                                    ) : t.draft ? (
                                      <button type="button" className="lab-btn lab-btn--primary lab-btn--full" onClick={() => send(t)}>
                                        Send reply
                                      </button>
                                    ) : (
                                      <button type="button" className="lab-btn lab-btn--primary lab-btn--full" onClick={() => snooze(t)}>
                                        Leave it until 4pm
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className="lb-more"
                                      aria-label="More actions"
                                      aria-expanded={menu === t.id}
                                      onClick={() => setMenu(menu === t.id ? null : t.id)}
                                    >
                                      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                                        <circle cx="4" cy="10" r="1.6" fill="currentColor" />
                                        <circle cx="10" cy="10" r="1.6" fill="currentColor" />
                                        <circle cx="16" cy="10" r="1.6" fill="currentColor" />
                                      </svg>
                                    </button>
                                  </div>

                                  {menu === t.id && (
                                    <div className="lb-menu lab-fade-in" role="menu">
                                      {status(t.id) === 'needs' || status(t.id) === 'snoozed' ? (
                                        <>
                                          {t.draft && (
                                            <button type="button" role="menuitem" className="lb-menu__item" onClick={() => snooze(t)}>
                                              Snooze to 4pm
                                            </button>
                                          )}
                                          <button type="button" role="menuitem" className="lb-menu__item" onClick={() => file(t)}>
                                            File it
                                          </button>
                                        </>
                                      ) : (
                                        <button type="button" role="menuitem" className="lb-menu__item" onClick={() => closeLoop(t)}>
                                          Close it
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </article>
                )
              })}
            </div>

            <p className="lb-note">
              {isLive
                ? 'Lower priority mail lives here with the score that put it there, and rises the moment that score does.'
                : 'Every one of these says why it was filed, and any of it can be pulled back.'}
            </p>
          </main>

          <aside className="lb-side">
            <div className="lb-head lb-head--side">
              <span className="lab-kicker">More</span>
            </div>

            {promos.length > 0 && (
              <section className="lb-fold">
                <button type="button" className="lb-fold__head" aria-expanded={promosOpen} onClick={() => setPromosOpen((v) => !v)}>
                  <span className="lab-kicker">Promos &amp; ads</span>
                  <span className="lb-fold__sum lab-num">{promos.length} · never interrupts you</span>
                </button>
                {promosOpen && (
                  <ul className="lb-promos lab-fade-in">
                    {promoGroups.map((g) => (
                      <li key={g.key} className="lb-promo">
                        <span className="lb-promo__who">{g.name}</span>
                        <ul className="lb-promo__mails">
                          {g.mails.map((t) => (
                            <li key={t.id}>
                              <span className="lb-promo__subj">{t.subject}</span>
                              <button
                                type="button"
                                className="lb-chip"
                                onClick={() => {
                                  setItems((prev) => ({ ...prev, [t.id]: { status: 'needs', note: 'You pulled it out of the promo pile' } }))
                                  setFilter('needs')
                                  flash('Back in the brief.', () => setItems((prev) => ({ ...prev, [t.id]: { status: 'filed' } })))
                                }}
                              >
                                Bring back
                              </button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="lab-note lb-fold__foot">Collapsed on purpose. Nothing here can reach the top of the brief.</p>
              </section>
            )}

            {!isLive && (
              <section className="lb-fold">
                <button type="button" className="lb-fold__head" aria-expanded={weekOpen} onClick={() => setWeekOpen((v) => !v)}>
                  <span className="lab-kicker">The week</span>
                  <span className="lb-fold__sum lab-num">
                    {pips.length} open · {pips.filter((p) => p.kind === 'deadline' || p.kind === 'chase').length} with a clock
                  </span>
                </button>
                {weekOpen && (
                  <ul className="lb-week lab-fade-in">
                    {DAYS.map((day, i) => {
                      const dayPips = pips.filter((p) => p.day === i)
                      if (dayPips.length === 0) return null
                      return (
                        <li key={day} className={i === 0 ? 'is-today' : ''}>
                          <span className="lb-week__day lab-num">{day}</span>
                          <span className="lb-week__pips">
                            {dayPips.map((p) => {
                              const done = status(p.target) === 'sent'
                              return (
                                <button key={p.id} type="button" className={`lb-pip is-${done ? 'waiting' : p.kind}`} onClick={() => jump(p.target)}>
                                  <span className="lb-pip__dot" aria-hidden="true" />
                                  <span className="lb-pip__text">{p.title}</span>
                                </button>
                              )
                            })}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )}

            <section className="lb-fold" id="lb-settings">
              <button type="button" className="lb-fold__head" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
                <span className="lab-kicker">Alpha's rules</span>
                <span className="lb-fold__sum lab-num">
                  {rulesOn} on · {interrupted} of 4 interrupts
                </span>
              </button>
              {settingsOpen && (
                <div className="lb-fold__body lab-fade-in">
                  <ul className="lb-switches">
                    {rules.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={r.on}
                          aria-label={r.label}
                          className="lab-switch"
                          disabled={r.locked}
                          onClick={() => setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, on: !x.on } : x)))}
                        />
                        <span className={`lb-switch__label${r.locked ? ' is-locked' : ''}`}>{r.label}</span>
                      </li>
                    ))}
                  </ul>
                  <ul className="lb-switches lb-switches--sub">
                    {interrupts.map((it) => (
                      <li key={it.id}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={it.on}
                          aria-label={it.label}
                          className="lab-switch"
                          onClick={() => setInterrupts((prev) => prev.map((x) => (x.id === it.id ? { ...x, on: !x.on } : x)))}
                        />
                        <span className="lb-switch__label">{it.label}</span>
                      </li>
                    ))}
                  </ul>
                  {!isLive && (
                    <div className="lb-default-tone">
                      <span className="lb-switch__label">New drafts arrive</span>
                      <div className="lb-default-tone__chips">
                        {(['casual', 'plain', 'formal'] as Tone[]).map((tone) => (
                          <button
                            key={tone}
                            type="button"
                            className={`lb-chip lb-chip--tone${defaultTone === tone ? ' is-active' : ''}`}
                            aria-pressed={defaultTone === tone}
                            onClick={() => applyDefaultTone(tone)}
                          >
                            {TONE_LABEL[tone]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="lb-ledger-row lab-num">
                    Read 31 · Filed {filed.length} · Drafts 5 · Sent without you 0
                  </p>
                  <p className="lb-honest-line">If Gmail drops, the brief says so instead of going quiet.</p>
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>

      {toast && (
        <div className="lab-toast" role="status">
          <span>{toast.text}</span>
          <button
            type="button"
            className="lab-btn lab-btn--plain"
            onClick={() => {
              toast.undo()
              setToast(null)
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
