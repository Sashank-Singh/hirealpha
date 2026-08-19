/**
 * Pure helpers for Gmail queries and MIME body parsing.
 * Kept separate so tests can import without pulling in the full server.
 */

/**
 * Recent inbox batch for the brief. Hygiene only: skip spam and Gmail Promotions
 * (and social/forums tabs). Does NOT require starred, Gmail important, or Primary.
 * category:updates is left in so banks, shipping, and receipts can still arrive.
 * A model then judges which of these are actually worth showing.
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

/** Prompt for the brief mail judge. No sender denylist. The model decides. */
export function mailJudgePrompt(items: MailJudgeItem[]): string {
  const listed = items
    .map(
      (m, i) =>
        `${i + 1}. From: ${m.from || '(unknown)'}\n   Subject: ${m.subject || '(no subject)'}\n   Snippet: ${m.snippet || ''}`,
    )
    .join('\n')
  return `Keep only mail a person would actually act on today: a human writing to them, work, money, time sensitive notes, a reply, a real conversation.
Drop marketing, newsletters, automated job boards, recruiting blasts, social network job suggestions, and promo even if it is personalised.
Do not use Gmail stars or Gmail important flags. Judge the content.
Reply JSON only: {"keep":[1,4]} using the numbered items. Empty keep is allowed.

${listed}`
}

/** Parse {"keep":[1,3]} or {"keep":["id"]} from the judge. Unknown ids are ignored. */
export function parseMailJudgeKeepIds(raw: string, items: MailJudgeItem[]): string[] {
  const fence = String(raw || '').match(/\{[\s\S]*\}/)
  if (!fence) return []
  let data: { keep?: unknown }
  try {
    data = JSON.parse(fence[0]) as { keep?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(data.keep)) return []
  const ids: string[] = []
  for (const k of data.keep) {
    if (typeof k === 'number' && Number.isFinite(k)) {
      const item = items[k - 1]
      if (item) ids.push(item.id)
      continue
    }
    if (typeof k === 'string') {
      const trimmed = k.trim()
      if (/^\d+$/.test(trimmed)) {
        const item = items[Number(trimmed) - 1]
        if (item) ids.push(item.id)
        continue
      }
      if (items.some((item) => item.id === trimmed)) ids.push(trimmed)
    }
  }
  return [...new Set(ids)]
}

export function cleanMailSnippet(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/&nbsp;/gi, ' ').trim().slice(0, 140)
}

/** Compact iMessage / OG body for a morning brief. No hyphens or dashes. */
export function formatBriefPreview(input: {
  calendar: string[]
  emails: string[]
  tomorrow?: string[]
}): string {
  const bits: string[] = []
  const cal = input.calendar.slice(0, 3)
  bits.push(cal.length ? cal.join('\n') : 'Nothing on the calendar.')
  const mail = input.emails.slice(0, 3)
  bits.push(mail.length ? mail.join('\n') : 'No important mail')
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
