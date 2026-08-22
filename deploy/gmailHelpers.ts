/**
 * Pure helpers for Gmail queries and MIME body parsing.
 * Kept separate so tests can import without pulling in the full server.
 */

/**
 * Recent inbox batch for the brief. Hygiene only: skip spam and Gmail Promotions
 * (and social/forums tabs). Does NOT require starred, Gmail important, or Primary.
 * category:updates is left in so banks, shipping, and receipts can still arrive.
 * The brief groups what remains (reply, thanks, assessments) instead of hiding most of it.
 */
export function importantMailQuery(timespan: string): string {
  return `is:inbox -is:spam -category:promotions -category:social -category:forums newer_than:${timespan}`
}

export type MailJudgeItem = {
  id: string
  from: string
  subject: string
  snippet: string
}

export const MAIL_JUDGE_SYSTEM =
  'You pick which emails belong on a short morning brief. Reply JSON only.'

/**
 * Prompt for the brief mail judge. No sender denylist. The model decides.
 *
 * It answers two questions in one call: keep or drop, and what pile this mail
 * belongs in. `vocab` is the labels this user's own mail has produced before —
 * offered, never enforced, so the pile names converge on their words instead of
 * being re-invented every run. An empty vocab is the first-run case.
 */
export function mailJudgePrompt(items: MailJudgeItem[], vocab: string[] = []): string {
  const listed = items
    .map(
      (m, i) =>
        `${i + 1}. From: ${m.from || '(unknown)'}\n   Subject: ${m.subject || '(no subject)'}\n   Snippet: ${m.snippet || ''}`,
    )
    .join('\n')
  const known = vocab.filter(Boolean).slice(0, 12)
  const reuse = known.length
    ? `\nReuse one of these kinds when it fits, so the piles stay stable between days: ${known.join(', ')}.\nOnly invent a new kind when none of them fit.`
    : ''
  return `Keep only mail a person would actually act on today: a human writing to them, work, money, time sensitive notes, a reply, a real conversation.
Drop marketing, newsletters, automated job boards, recruiting blasts, social network job suggestions, and promo even if it is personalised.
Do not use Gmail stars or Gmail important flags. Judge the content.
Also say what kind of mail each one is: one or two plain words for the pile a person would file it under, like take home, invoice, intro, scheduling. Not a summary, not the sender.${reuse}
Reply JSON only, one line per numbered item: {"items":[{"i":1,"keep":true,"kind":"take home"},{"i":2,"keep":false,"kind":"newsletter"}]}

${listed}`
}

export type MailJudgeVerdict = { id: string; keep: boolean; kind: string }

/** Resolve "1" / 1 / a raw gmail id to the batch item it names. */
function judgeItemAt(ref: unknown, items: MailJudgeItem[]): MailJudgeItem | undefined {
  if (typeof ref === 'number' && Number.isFinite(ref)) return items[ref - 1]
  if (typeof ref !== 'string') return undefined
  const trimmed = ref.trim()
  if (/^\d+$/.test(trimmed)) return items[Number(trimmed) - 1]
  return items.find((item) => item.id === trimmed)
}

/**
 * Parse the judge's reply into a verdict per item. Accepts the current
 * {"items":[{"i":1,"keep":true,"kind":"invoice"}]} shape and the older
 * {"keep":[1,3]} one, because a model that has seen the old format in the wild
 * still answers in it sometimes and dropping the batch would cost the brief.
 */
export function parseMailJudgeVerdicts(raw: string, items: MailJudgeItem[]): MailJudgeVerdict[] {
  const fence = String(raw || '').match(/\{[\s\S]*\}/)
  if (!fence) return []
  let data: { items?: unknown; keep?: unknown }
  try {
    data = JSON.parse(fence[0]) as { items?: unknown; keep?: unknown }
  } catch {
    return []
  }
  const out = new Map<string, MailJudgeVerdict>()
  if (Array.isArray(data.items)) {
    for (const row of data.items) {
      if (!row || typeof row !== 'object') continue
      const r = row as { i?: unknown; n?: unknown; id?: unknown; keep?: unknown; kind?: unknown }
      const item = judgeItemAt(r.i ?? r.n ?? r.id, items)
      if (!item) continue
      // An item listed with no verdict is a keep — the model bothered to name it.
      const keep = r.keep === undefined ? true : r.keep !== false && r.keep !== 'false' && r.keep !== 0
      out.set(item.id, { id: item.id, keep, kind: normalizeMailKind(String(r.kind || '')) })
    }
  }
  if (Array.isArray(data.keep)) {
    for (const k of data.keep) {
      const item = judgeItemAt(k, items)
      if (item && !out.has(item.id)) out.set(item.id, { id: item.id, keep: true, kind: '' })
    }
  }
  return [...out.values()]
}

/** Parse {"keep":[1,3]} or {"keep":["id"]} from the judge. Unknown ids are ignored. */
export function parseMailJudgeKeepIds(raw: string, items: MailJudgeItem[]): string[] {
  return parseMailJudgeVerdicts(raw, items)
    .filter((v) => v.keep)
    .map((v) => v.id)
}

export type MailKind = 'reply' | 'thanks' | 'assessment' | 'money' | 'other'

export const MAIL_GROUP_LABEL: Record<MailKind, string> = {
  reply: 'To reply',
  assessment: 'Assessments',
  thanks: 'Thanks',
  money: 'Money',
  other: 'More',
}

const MAIL_GROUP_ORDER: MailKind[] = ['reply', 'assessment', 'thanks', 'money', 'other']

/** Already singular, or uncountable, despite the trailing s. */
const KEEP_PLURAL = new Set(['thanks', 'news', 'sales', 'logistics', 'expenses'])

/** Not a pile name — the model saying "it is an email" tells us nothing. */
const NOT_A_KIND = new Set(['email', 'emails', 'mail', 'message', 'inbox', 'unknown', 'none', 'na', 'null', 'kind'])

function singularizeKind(word: string): string {
  if (KEEP_PLURAL.has(word) || word.length < 4) return word
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`
  if (/(ch|sh|ss|x|z|s)es$/.test(word)) return word.slice(0, -2)
  if (/(ss|us|is)$/.test(word)) return word
  if (/s$/.test(word)) return word.slice(0, -1)
  return word
}

/**
 * Fold a model-written kind into a stable slug: lowercase, punctuation out,
 * at most three words, singular, 24 chars. Returns '' for anything that is not a
 * pile name, which is the signal to fall back to `classifyBriefMail`.
 */
export function normalizeMailKind(raw: string): string {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/[\s-]+/g, ' ')
    .trim()
  if (!cleaned) return ''
  // The model sometimes answers with a sentence. A pile name is one or two words.
  // Bare digits and single letters never name a pile, so they never take a slot.
  const words = cleaned.split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w)).slice(0, 3)
  if (!words.length) return ''
  words[words.length - 1] = singularizeKind(words[words.length - 1]!)
  const out: string[] = []
  for (const w of words) {
    const next = out.length ? `${out.join('-')}-${w}` : w
    if (next.length > 24) break
    out.push(w)
  }
  const slug = out.length ? out.join('-') : words[0]!.slice(0, 24)
  // Check the joined form too, so a punctuated non-answer like "n/a" is caught.
  if (slug.length < 2 || NOT_A_KIND.has(slug) || NOT_A_KIND.has(slug.replace(/-/g, ''))) return ''
  return slug
}

/**
 * Seat a kind in the vocabulary this user's mail has already produced, so
 * "interview invite" joins the existing "interview" pile instead of starting a
 * near-duplicate one. Exact slug, then a whole-word overlap, then a shared
 * five-character stem. Unmatched kinds pass through and become new vocabulary.
 */
export function snapMailKind(raw: string, vocab: string[]): string {
  const slug = normalizeMailKind(raw)
  if (!slug) return ''
  const known = vocab.map(normalizeMailKind).filter(Boolean)
  if (known.includes(slug)) return slug
  const words = slug.split('-')
  for (const k of known) {
    if (words.includes(k) || k.split('-').includes(slug)) return k
  }
  for (const k of known) {
    if (k.length >= 5 && slug.length >= 5 && k.slice(0, 5) === slug.slice(0, 5)) return k
  }
  return slug
}

/** Display name for a kind: the fixed five keep their copy, slugs get title case. */
export function mailKindLabel(kind: string): string {
  const known = MAIL_GROUP_LABEL[kind as MailKind]
  if (known) return known
  const words = String(kind || '').split('-').filter(Boolean)
  if (!words.length) return MAIL_GROUP_LABEL.other
  return `${words[0]!.charAt(0).toUpperCase()}${words[0]!.slice(1)}${words.length > 1 ? ` ${words.slice(1).join(' ')}` : ''}`
}

/** "3 to reply", "1 assessment", "2 take homes". */
export function mailKindPhrase(kind: string, n: number, label?: string): string {
  if (kind === 'reply') return `${n} to reply`
  if (kind === 'assessment') return n === 1 ? '1 assessment' : `${n} assessments`
  if (kind === 'thanks') return `${n} thanks`
  if (kind === 'money') return n === 1 ? '1 money note' : `${n} money notes`
  if (kind === 'other' || (!kind && !label)) return n === 1 ? '1 more' : `${n} more`
  // Generated kinds arrive singular from normalizeMailKind, so pluralising here
  // is safe in a way it would not be for the fixed labels above.
  const name = (kind ? mailKindLabel(kind) : String(label)).toLowerCase()
  if (n === 1) return `1 ${name}`
  return `${n} ${/(s|x|z|ch|sh)$/.test(name) ? `${name}es` : `${name}s`}`
}

/** Promo, job boards, and machine mail the brief should not spend space on. */
export function isNoiseMail(m: { from: string; subject: string; snippet?: string }): boolean {
  const from = String(m.from || '').toLowerCase()
  const hay = `${from} ${m.subject || ''} ${m.snippet || ''}`.toLowerCase()
  if (/\bnew message from\b/.test(hay)) return false
  if (/\b(linkedin job|job alert|jobs you might like|indeed\.com|glassdoor)\b/.test(hay)) return true
  if (/\bunsubscribe\b/.test(hay) && /\b(% off|limited time|sale|newsletter)\b/.test(hay)) return true
  return false
}

export function classifyBriefMail(m: { from: string; subject: string; snippet?: string }): MailKind {
  const hay = `${m.from || ''} ${m.subject || ''} ${m.snippet || ''}`.toLowerCase()
  if (/\b(assessment|take[- ]home|coding challenge|hackerrank|codesignal|case study|homework assignment|complete your (test|task))\b/.test(hay)) {
    return 'assessment'
  }
  if (/\b(invoice|receipt|payment|paid|wire|venmo|zelle|statement|refund|charged)\b/.test(hay)) return 'money'
  if (/\b(thank you|thanks|thx|appreciate it|grateful)\b/.test(hay) && !/[?]/.test(hay) && !/\b(can you|could you|let me know|please reply)\b/.test(hay)) {
    return 'thanks'
  }
  if (
    /\bnew message from\b/.test(hay) ||
    /[?]/.test(hay) ||
    /\b(can you|could you|let me know|please reply|waiting on|wanted to check|when you get a chance|need you to)\b/.test(hay)
  ) {
    return 'reply'
  }
  const from = String(m.from || '')
  const name = from.replace(/<[^>]+>/g, '').trim()
  if (name && !/no-?reply|team@|notifications@|newsletter/i.test(from) && /\s/.test(name)) return 'reply'
  return 'other'
}

export type BriefMailBucket = {
  /** A fixed MailKind, or a slug the judge produced for this user. */
  kind: string
  label: string
  count: number
  items: Array<{ id: string; from: string; subject: string; snippet?: string }>
}

export function groupBriefMail(
  items: Array<{ id: string; from: string; subject: string; snippet?: string }>,
): BriefMailBucket[] {
  const buckets: Record<MailKind, BriefMailBucket['items']> = {
    reply: [],
    assessment: [],
    thanks: [],
    money: [],
    other: [],
  }
  for (const m of items) {
    if (isNoiseMail(m)) continue
    buckets[classifyBriefMail(m)].push(m)
  }
  return MAIL_GROUP_ORDER.filter((kind) => buckets[kind].length).map((kind) => ({
    kind,
    label: MAIL_GROUP_LABEL[kind],
    count: buckets[kind].length,
    items: buckets[kind],
  }))
}

export type MailKindItem = {
  id: string
  from: string
  subject: string
  snippet?: string
  /** What the judge called this mail. Absent when the judge did not reach it. */
  kind?: string
}

/**
 * Group mail by the kinds the judge named, falling back per item to the regex
 * classifier — so an unjudged tail, or a run where the model was unavailable,
 * degrades to exactly the old five-bucket behaviour instead of losing the mail.
 *
 * Piles sort by size rather than a fixed order, because with self-naming kinds
 * there is no fixed order to sort by. 'other' is pinned last: it is the catch-all,
 * not a pile that happens to be small.
 */
export function groupMailByKind(
  items: MailKindItem[],
  opts?: { maxGroups?: number; vocab?: string[] },
): BriefMailBucket[] {
  const maxGroups = Math.max(1, opts?.maxGroups ?? 4)
  const vocab = opts?.vocab || []
  const seen: string[] = []
  const piles = new Map<string, BriefMailBucket['items']>()
  for (const m of items) {
    if (isNoiseMail(m)) continue
    const kind = snapMailKind(m.kind || '', vocab) || classifyBriefMail(m)
    let pile = piles.get(kind)
    if (!pile) {
      pile = []
      piles.set(kind, pile)
      seen.push(kind)
    }
    pile.push(m)
  }
  const sorted = [...piles.keys()].sort((a, b) => {
    if (a === 'other') return 1
    if (b === 'other') return -1
    return piles.get(b)!.length - piles.get(a)!.length || seen.indexOf(a) - seen.indexOf(b)
  })
  const bucket = (kind: string): BriefMailBucket => ({
    kind,
    label: mailKindLabel(kind),
    count: piles.get(kind)!.length,
    items: piles.get(kind)!,
  })
  if (sorted.length <= maxGroups) return sorted.map(bucket)
  // Past the cap the tail becomes one More pile. A long tail of one-mail groups
  // is the specific way a self-naming label set goes wrong.
  const kept = sorted.slice(0, maxGroups - 1)
  const rest = sorted.slice(maxGroups - 1).flatMap((k) => piles.get(k)!)
  return [
    ...kept.map(bucket),
    { kind: 'other', label: MAIL_GROUP_LABEL.other, count: rest.length, items: rest },
  ]
}

export function mailTally(groups: Array<{ kind: string; count: number; label?: string }>): string {
  return groups.map((g) => mailKindPhrase(g.kind, g.count, g.label)).join('  ')
}

/**
 * Importance scoring for the brief's Needs You section.
 * Pure heuristics over what the inbox already gives us: judged kind, ask
 * language, deadline language, and this user's own history with the sender.
 * The score decides which three mails lead the brief; the reasons are shown
 * as chips so the ranking never feels arbitrary.
 */
export type MailScoreReason = 'waiting_on_you' | 'deadline' | 'vip_sender' | 'money'

/** Per-sender history from hire_mail_feedback, resolved by the caller. */
export type SenderSignal = {
  /** Times the user replied or drafted to this sender. */
  replies?: number
  /** Times the user skipped this sender's brief picks. Two skips bury them. */
  skips?: number
}

/** The stable identity of a sender: the bare address when there is one. */
export function senderKey(from: string): string {
  const inner = String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '')
  const addr = inner.trim().toLowerCase()
  return /^[^@\s]+@[^@\s]+$/.test(addr) ? addr : addr.slice(0, 80)
}

const WAITING_ON_YOU =
  /\bnew message from\b|[?]\s*$|(?:^|\s)(can you|could you|let me know|please reply|waiting on|when you get a chance|need you to|wanted to check|following up|gentle (?:reminder|nudge)|any update)\b/i

/** Ask language: the ball is in the user's court. */
export function mailWaitingOnYou(m: { subject: string; snippet?: string }): boolean {
  const hay = `${m.subject || ''} ${m.snippet || ''}`
  return /\bnew message from\b/.test(hay) || WAITING_ON_YOU.test(hay)
}

const DEADLINE_RE =
  /\b(rsvp|deadline|expires?|closes?|due\s+(?:by|on|today|tomorrow)|by\s+(?:mon|tues?|wed|thu(?:rs)?|fri|sat|sun)(?:day)?|by\s+(?:today|tomorrow|eod)|end of (?:day|week)|last day)\b/i

export function mailHasDeadline(m: { subject: string; snippet?: string }): boolean {
  return DEADLINE_RE.test(`${m.subject || ''} ${m.snippet || ''}`)
}

export function scoreMail(
  m: { id: string; from: string; subject: string; snippet?: string; kind?: string },
  sender?: SenderSignal,
): { score: number; reasons: MailScoreReason[] } {
  let score = 40
  const reasons: MailScoreReason[] = []
  if (m.kind === 'reply' || mailWaitingOnYou(m)) {
    score += 25
    reasons.push('waiting_on_you')
  } else if (m.kind === 'money') {
    score += 18
    reasons.push('money')
  } else if (m.kind === 'assessment') {
    score += 18
  } else if (m.kind && m.kind !== 'other' && m.kind !== 'thanks') {
    score += 10
  }
  if (mailHasDeadline(m)) {
    score += 20
    reasons.push('deadline')
  }
  const replies = sender?.replies || 0
  if (replies > 0) {
    score += Math.min(30, 12 * replies)
    reasons.push('vip_sender')
  }
  if ((sender?.skips || 0) >= 2) score -= 35
  return { score: Math.max(0, Math.min(100, score)), reasons }
}

/**
 * Score a batch and hand back the top leads. `signalFor` resolves per-sender
 * history so the caller owns persistence; unmapped senders score cold.
 */
export function topNeedsYou<
  T extends { id: string; from: string; subject: string; snippet?: string; kind?: string },
>(items: T[], signalFor: (key: string) => SenderSignal | undefined, limit = 3): Array<T & { score: number; reasons: MailScoreReason[] }> {
  return items
    .map((m) => ({ ...m, ...scoreMail(m, signalFor(senderKey(m.from))) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
}

export function cleanMailSnippet(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/&nbsp;/gi, ' ').trim().slice(0, 140)
}

/** Compact iMessage / OG body for a morning brief. No hyphens or dashes. */
export function formatBriefPreview(input: {
  calendar: string[]
  emails: string[]
  tomorrow?: string[]
  lead?: string
}): string {
  const bits: string[] = []
  const cal = input.calendar.slice(0, 3)
  if (cal.length) bits.push(cal.join('\n'))
  else if (input.lead) bits.push(input.lead)
  const mail = input.emails.slice(0, 3)
  if (mail.length) bits.push(mail.join('\n'))
  const tom = (input.tomorrow || []).slice(0, 2)
  if (tom.length) bits.push(`Tomorrow: ${tom.join('; ')}`)
  return bits.join('\n').slice(0, 320)
}

/** Recursive MIME part for Gmail full-format messages. */
export interface GmailMimePart {
  mimeType?: string
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailMimePart[]
}

export function decodeGmailBody(s: string): string {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
    return Buffer.from(b64, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

/**
 * Walk Gmail MIME parts recursively to extract text/plain and text/html bodies.
 * Prefers html, falls back to plain text.
 * Skips parts with no inline data (only an attachmentId).
 */
export function extractGmailBody(part?: GmailMimePart): { text: string; html: string } {
  if (!part) return { text: '', html: '' }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return { text: '', html: decodeGmailBody(part.body.data) }
  }
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return { text: decodeGmailBody(part.body.data), html: '' }
  }
  if (part.parts?.length) {
    let text = ''
    let html = ''
    for (const sub of part.parts) {
      const r = extractGmailBody(sub)
      if (!text && r.text) text = r.text
      if (!html && r.html) html = r.html
    }
    return { text, html }
  }
  return { text: '', html: '' }
}

/* ---- Gmail through Composio ----
 * Some accounts connect Gmail through Composio instead of signing in with
 * Google, and Composio's connector returns whatever shape it chose: a bare
 * array, {messages:[...]}, or the rows buried under a wrapper. The shape has to
 * be read for the *message id*, not just the human fields — a row with no id can
 * be listed but never opened. Parsing lives here so it is testable without a
 * Composio account.
 */

export type ComposioMailItem = {
  /** Gmail message id, or '' when the connector did not return one. */
  id: string
  from: string
  date: string
  subject: string
  snippet: string
}

export type ComposioMailBody = ComposioMailItem & { bodyText: string; bodyHtml: string }

const MAIL_ID_KEYS = ['messageId', 'message_id', 'id', 'gmailMessageId', 'gmail_message_id']
const MAIL_FROM_KEYS = ['sender', 'from', 'from_email', 'fromEmail', 'sender_email', 'senderEmail']
const MAIL_SUBJECT_KEYS = ['subject', 'subject_header', 'subjectHeader']
const MAIL_DATE_KEYS = [
  'messageTimestamp',
  'message_timestamp',
  'date',
  'internalDate',
  'internal_date',
  'receivedAt',
  'received_at',
  'timestamp',
]
const MAIL_SNIPPET_KEYS = ['snippet', 'body_preview', 'bodyPreview', 'messageText', 'message_text']
const MAIL_TEXT_KEYS = ['messageText', 'message_text', 'bodyText', 'body_text', 'plain', 'text']
const MAIL_HTML_KEYS = ['messageHtml', 'message_html', 'bodyHtml', 'body_html', 'html']
/** Keys whose array value holds the rows, tried in order before a blind descent. */
const MAIL_LIST_KEYS = ['messages', 'emails', 'mail', 'items', 'results', 'data', 'response_data']

function firstString(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

type MailRecord = { item: ComposioMailItem; raw: Record<string, unknown> }

function mailRecordFrom(raw: unknown): MailRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const subject = firstString(o, MAIL_SUBJECT_KEYS)
  const from = firstString(o, MAIL_FROM_KEYS)
  // Neither a subject nor a sender means this object is a wrapper, not a message.
  if (!subject && !from) return null
  const preview = o.preview && typeof o.preview === 'object' ? (o.preview as Record<string, unknown>) : null
  const snippet = firstString(o, MAIL_SNIPPET_KEYS) || (preview ? firstString(preview, ['body', 'text', 'snippet']) : '')
  return {
    // Collapsing whitespace matters: these snippets go into a one-line-per-mail
    // block, and a raw newline would split one message into two.
    item: {
      id: firstString(o, MAIL_ID_KEYS),
      from,
      subject,
      date: firstString(o, MAIL_DATE_KEYS),
      snippet: cleanMailSnippet(snippet),
    },
    raw: o,
  }
}

function mailRecords(data: unknown, depth = 0): MailRecord[] {
  if (data == null || depth > 6) return []
  if (Array.isArray(data)) {
    const direct = data.map(mailRecordFrom).filter((x): x is MailRecord => !!x)
    if (direct.length) return direct
    return data.flatMap((x) => mailRecords(x, depth + 1))
  }
  if (typeof data !== 'object') return []
  const o = data as Record<string, unknown>
  for (const key of MAIL_LIST_KEYS) {
    if (Array.isArray(o[key])) {
      const got = mailRecords(o[key], depth + 1)
      if (got.length) return got
    }
  }
  const self = mailRecordFrom(o)
  if (self) return [self]
  return Object.values(o).flatMap((v) => mailRecords(v, depth + 1))
}

/** Pull mail rows out of a Composio Gmail payload, keeping the message id. */
export function parseComposioMailItems(data: unknown): ComposioMailItem[] {
  return mailRecords(data).map((r) => r.item)
}

/**
 * Pull one message, with its body, out of a Composio payload. `wantId` picks the
 * matching row; a response holding exactly one message is accepted as the answer
 * to a by-id read even when the connector left the id out.
 */
export function parseComposioMailBody(data: unknown, wantId = ''): ComposioMailBody | null {
  const recs = mailRecords(data)
  if (!recs.length) return null
  const hit = wantId ? recs.find((r) => r.item.id === wantId) || (recs.length === 1 ? recs[0] : null) : recs[0]
  if (!hit) return null
  const o = hit.raw
  let text = firstString(o, MAIL_TEXT_KEYS)
  let html = firstString(o, MAIL_HTML_KEYS)
  if (!text && !html && o.payload && typeof o.payload === 'object') {
    const walked = extractGmailBody(o.payload as GmailMimePart)
    text = walked.text
    html = walked.html
  }
  if (!text && !html) {
    const preview = o.preview && typeof o.preview === 'object' ? (o.preview as Record<string, unknown>) : null
    if (preview) text = firstString(preview, ['body', 'text'])
  }
  return { ...hit.item, id: hit.item.id || wantId, bodyText: text, bodyHtml: html }
}

/** The one-line-per-message block the model reads. */
export function formatComposioMailBlock(items: ComposioMailItem[]): string {
  if (!items.length) return 'No emails matched the query.'
  const lines = items.map((m) => {
    const from = m.from.replace(/<[^>]+>/g, '').trim()
    return `- ${from || '?'} | ${m.date || '?'} | ${m.subject || '(no subject)'} | ${m.snippet}`
  })
  return `Important email:\n${lines.join('\n')}`
}
