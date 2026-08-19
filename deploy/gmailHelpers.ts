/**
 * Pure helpers for Gmail queries and MIME body parsing.
 * Kept separate so tests can import without pulling in the full server.
 */

/**
 * Shared important-mail Gmail query.
 * Excludes junk (promotions, social, forums, spam) without hiding need-to-know mail.
 * category:updates is intentionally NOT excluded so transactional mail (shipping,
 * banking, GitHub, calendar invites, receipts) reaches the brief.
 * Mail qualifies if it is starred, Gmail-prioritised, or lands in Primary.
 * timespan should be Gmail-style like '2d', '16h', '12h'.
 */
export function importantMailQuery(timespan: string): string {
  return `is:inbox -is:spam -category:promotions -category:social -category:forums (is:important OR category:primary OR is:starred) newer_than:${timespan}`
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
