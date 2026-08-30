/**
 * One model call judges everything that used to be regexes: which mail needs
 * the user, how urgent each piece is, what pile it files under, and which of
 * today's meetings deserve prep. Pure prompt + parse so tests run without the
 * server. The regex tiers in scoreMail/pickAttentionEmail remain only as the
 * path taken when the model answers nothing.
 */

export type JudgeMailIn = { id: string; from: string; subject: string; snippet?: string }
export type JudgeMeetIn = { id: string; time: string; title: string; who?: string }

export type MailVerdict = {
  id: string
  keep: boolean
  kind: string
  /** True when the ball is in the user's court — ask language, a deadline, a promise to them. */
  needsYou: boolean
  /** 0-100 urgency/importance as judged by the model. */
  score: number
  /** One short phrase the UI can show as the reason, like "invoice due tomorrow". */
  why: string
  /** When the mail carries a commitment about the future, who owes what, quoted not invented. */
  promise?: string
}

export type MeetVerdict = {
  id: string
  /** True when the meeting benefits from the user walking in prepared. */
  prep: boolean
  why: string
}

export type JudgeAll = { mails: Map<string, MailVerdict>; meets: Map<string, MeetVerdict> }

export const JUDGE_ALL_SYSTEM =
  'You are the judgment layer of a personal assistant brief. ' +
  'You decide which mail and which meetings actually need the human today. Reply JSON only.'

/**
 * One prompt over the whole batch — mail and meetings together — so opening the
 * brief costs at most a single request. `vocab` is the pile vocabulary this
 * user's own mail has produced before, offered not enforced, same contract as
 * the mail judge.
 */
export function judgeAllPrompt(mails: JudgeMailIn[], meets: JudgeMeetIn[], vocab: string[] = []): string {
  const mailList = mails
    .map(
      (m, i) =>
        `${i + 1}. Id: ${m.id}\n   From: ${m.from || '(unknown)'}\n   Subject: ${m.subject || '(no subject)'}\n   Snippet: ${m.snippet || ''}`,
    )
    .join('\n')
  const meetList = meets
    .map((m, i) => `${i + 1}. Id: ${m.id} — ${m.time} — ${m.who || m.title}`)
    .join('\n')
  const known = vocab.filter(Boolean).slice(0, 12)
  const reuse = known.length
    ? `\nReuse one of these kinds when it fits, so the piles stay stable between days: ${known.join(', ')}.\nOnly invent a new kind when none of them fit.`
    : ''
  const meetBlock = meets.length
    ? `\n\nMeetings today:\n${meetList}\n\nFor each meeting say "prep": true only when walking in prepared genuinely helps — a human the user is selling to, reporting to, or being interviewed by, or a meeting with an obvious deliverable. False for recurring syncs, holds, and holds-that-could-be-emails.`
    : ''
  return `Mail${mails.length ? `:\n${mailList}` : ':\n(none)'}${meetBlock}${reuse}

Judge the content, not Gmail stars or labels. For each mail decide:
- "keep": would a person act on this today? Drop marketing, newsletters, blasts, receipts with nothing owed.
- "kind": one or two plain words for the pile a person would file it under, like take home, invoice, intro, scheduling. Not a summary.
- "needsYou": true only when the ball is in the user's court — someone asks them for something, a reply is wanted, money is owed, a deadline or RSVP lands soon.
- "score": 0-100 for how much this needs the user today. Reserve 80+ for money owed, hard deadlines, and people they wrote to first waiting on an answer. A plain FYI sits near 30.
- "why": at most six words naming the concrete reason, like "invoice due tomorrow" or "Priya wants an answer".
When an email carries a commitment about the future, someone promising to send, deliver, review, reply, or follow up by a time, add "promise": one short phrase naming who owes what, like "Priya sends the specs by Friday". Omit "promise" when there is none. Never invent a commitment; quote the obligation as the email states it.

Reply JSON only, one row per numbered item, using the exact ids shown:
{"mails":[{"id":"<mail id>","keep":true,"kind":"invoice","needsYou":true,"score":85,"why":"invoice due tomorrow","promise":"Priya sends specs by Friday"}]${meets.length ? ',"meets":[{"id":"<meeting id>","prep":true,"why":"intro call with investor"}]' : ''}}`
}

function clampScore(n: unknown): number {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, v))
}

function shortWhy(raw: unknown): string {
  const s = String(raw || '').trim().replace(/\s+/g, ' ')
  if (!s) return ''
  const words = s.split(' ')
  return words.slice(0, 6).join(' ')
}

function idFor(ref: unknown, pool: Array<{ id: string }>, index: number): string | null {
  if (typeof ref === 'string' && ref.trim()) {
    const s = ref.trim()
    if (pool.some((p) => p.id === s)) return s
    const n = Number(s)
    if (Number.isFinite(n)) {
      const byIndex = pool[n - 1]
      if (byIndex) return byIndex.id
    }
    return null
  }
  if (typeof ref === 'number' && Number.isFinite(ref)) {
    const byIndex = pool[ref - 1]
    if (byIndex) return byIndex.id
  }
  // A row that names nothing falls back to its position, so a model that
  // truncates its id field still lands its verdict on the right mail.
  const positional = pool[index]
  return positional ? positional.id : null
}

/** Parse the judge's reply. Tolerates a fenced object and missing fields; unknown ids are dropped. */
export function parseJudgeAll(raw: string, mails: JudgeMailIn[], meets: JudgeMeetIn[]): JudgeAll {
  const out: JudgeAll = { mails: new Map(), meets: new Map() }
  const fence = String(raw || '').match(/\{[\s\S]*\}/)
  if (!fence) return out
  let data: { mails?: unknown; meets?: unknown }
  try {
    data = JSON.parse(fence[0]) as { mails?: unknown; meets?: unknown }
  } catch {
    return out
  }
  if (Array.isArray(data.mails)) {
    data.mails.forEach((row, i) => {
      if (!row || typeof row !== 'object') return
      const r = row as {
        id?: unknown
        keep?: unknown
        kind?: unknown
        needsYou?: unknown
        score?: unknown
        why?: unknown
        promise?: unknown
      }
      const id = idFor(r.id, mails, i)
      if (!id) return
      const keep = r.keep === undefined ? true : r.keep !== false && r.keep !== 'false' && r.keep !== 0
      const promise = typeof r.promise === 'string' ? r.promise.trim().slice(0, 200) : ''
      out.mails.set(id, {
        id,
        keep,
        kind: String(r.kind || '').trim().slice(0, 40),
        needsYou: r.needsYou === true || r.needsYou === 'true',
        score: clampScore(r.score),
        why: shortWhy(r.why),
        promise: promise || undefined,
      })
    })
  }
  if (Array.isArray(data.meets)) {
    data.meets.forEach((row, i) => {
      if (!row || typeof row !== 'object') return
      const r = row as { id?: unknown; prep?: unknown; why?: unknown }
      const id = idFor(r.id, meets, i)
      if (!id) return
      out.meets.set(id, { id, prep: r.prep === true || r.prep === 'true', why: shortWhy(r.why) })
    })
  }
  return out
}

export const JUDGE_TTL_MS = 15 * 60_000

/** A cached judgment is trusted for JUDGE_TTL_MS, and only for the day it was built. */
export function judgeRowFresh(builtAtMs: number | null, nowMs: number, builtDay: string | null, today: string): boolean {
  if (!builtAtMs || builtDay !== today) return false
  return nowMs - builtAtMs < JUDGE_TTL_MS
}

/** The cached judgment belongs to a batch of mail. When more than a third of
 * the current ids were never judged, the cache is blind to the new arrivals
 * and a refresh runs even inside the TTL. */
export function judgeRowCovers(cachedMailIds: string[] | null, currentMailIds: string[]): boolean {
  if (!cachedMailIds || !cachedMailIds.length) return false
  const known = new Set(cachedMailIds)
  const unseen = currentMailIds.filter((id) => !known.has(id)).length
  return unseen <= currentMailIds.length / 3
}
