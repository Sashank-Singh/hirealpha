/**
 * Gmail attachment reading for the experience-gap pass.
 *
 * Pure helpers (collect/decode/pdf text) are exported for tests without a
 * server import chain; the fetch helpers bind an attachment back to its source
 * message and thread so a summary can never be quoted without its origin.
 */
import type { SQL } from 'bun'
import { inflateSync } from 'node:zlib'
import { googleAccessToken } from '../connectors/hub'
import type { GmailMimePart } from '../gmailHelpers'

export type AttachmentMeta = {
  attachmentId: string
  filename: string
  mimeType: string
  size: number
}

/** Walk MIME parts and collect the parts that are real attachments. */
export function collectAttachments(part?: GmailMimePart): AttachmentMeta[] {
  const out: AttachmentMeta[] = []
  const walk = (p?: GmailMimePart): void => {
    if (!p) return
    if (p.body?.attachmentId) {
      out.push({
        attachmentId: p.body.attachmentId,
        filename: (p as { filename?: string }).filename || '',
        mimeType: p.mimeType || 'application/octet-stream',
        size: p.body.size || 0,
      })
    }
    for (const sub of p.parts || []) walk(sub)
  }
  walk(part)
  return out.filter((a) => a.attachmentId)
}

export function decodeAttachmentBytes(data: string): Uint8Array {
  const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

const TEXT_MIME = /^text\/(?:plain|csv|html|x-markdown)|application\/(?:json|xml|javascript|x-yaml)|message\/rfc822/i

/** Text-like by mime, or by extension when the mime is generic. */
export function attachmentIsTextLike(meta: { mimeType: string; filename?: string }): boolean {
  if (TEXT_MIME.test(meta.mimeType)) return true
  const name = String(meta.filename || '').toLowerCase()
  return /\.(?:txt|md|csv|json|xml|ya?ml|log|ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|sh|toml|ini|html?)$/.test(name)
}

export function attachmentIsPdf(meta: { mimeType: string; filename?: string }): boolean {
  return /pdf/i.test(meta.mimeType) || /\.pdf$/i.test(String(meta.filename || ''))
}

const PDF_TEXT_CAP = 8000

/**
 * Extraction outcomes. The contract is deliberately narrow: a status names
 * what happened, text is present only when extraction actually produced it,
 * and "partial" never reads as complete. Correct refusal beats plausible
 * garbage — a scanned contract must come back image_only, never as a summary
 * invented from two stray strings.
 */
export type ExtractionStatus =
  | 'extracted'      // text fully read (within caps)
  | 'partial'        // text read but truncated, some streams unreadable, or layout-lossy
  | 'unsupported'    // binary type with no safe text extraction
  | 'image_only'     // PDF has content streams but no text operators (scanned)
  | 'encrypted'      // password-protected / DRM
  | 'malformed'      // not a parseable document
  | 'too_large'      // exceeds the read budget
  | 'empty'          // zero-byte attachment

export type Extraction = { status: ExtractionStatus; text?: string; note?: string }

/**
 * Minimal PDF text extraction for the "what does this attachment say" job.
 * Walks `stream ... endstream` objects, inflates the FlateDecode ones, and
 * collects the literal strings the text-showing operators (Tj, TJ, ', ")
 * present. Encrypted PDFs report `encrypted`; a PDF whose streams hold no
 * text operators reports `image_only`; anything that inflates badly or is
 * truncated reports `partial` with the honest note attached. This parser is
 * intentionally narrow: uncompressed and FlateDecode literal-string PDFs read
 * well; hex-string/CID-font PDFs (common for CJK) come back `partial`, and
 * the copy says so instead of paraphrasing fragments.
 */
export function extractPdfText(bytes: Uint8Array): Extraction {
  if (bytes.byteLength === 0) return { status: 'empty' }
  const latin = Buffer.from(bytes).toString('latin1')
  if (!latin.startsWith('%PDF-')) return { status: 'malformed' }
  if (/\/Encrypt\s/.test(latin)) return { status: 'encrypted' }
  const streamRe = /stream\r?\n?/g
  const pieces: string[] = []
  let total = 0
  let streams = 0
  let failedStreams = 0
  let truncated = false
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(latin))) {
    const start = match.index + match[0].length
    const end = latin.indexOf('endstream', start)
    if (end < 0) break
    const chunk = latin.slice(start, end)
    streamRe.lastIndex = end + 'endstream'.length
    streams++
    let text = chunk
    if (!/\bBT\b/.test(chunk)) {
      try {
        const inflated = inflateSync(Buffer.from(chunk, 'latin1')).toString('latin1')
        if (/\bBT\b/.test(inflated)) text = inflated
        else continue
      } catch {
        failedStreams++
        continue
      }
    }
    let frags = 0
    for (const m of text.matchAll(/\((?:\\.|[^\\()])*\)|\bTJ\b|\bTj\b|\bTd\b|\bTD\b|\bT\*\b/g)) {
      const tok = m[0]
      if (tok === 'Tj' || tok === 'TJ') { pieces.push(' '); total++; continue }
      if (tok === 'Td' || tok === 'TD' || tok === 'T*') { pieces.push('\n'); total++; continue }
      const inner = tok.slice(1, -1).replace(/\\([()\\])/g, '$1').replace(/\\[nr]/g, ' ')
      pieces.push(inner)
      total += inner.length
      frags++
      if (total >= PDF_TEXT_CAP) { truncated = true; break }
    }
    pieces.push('\n')
    total++
    if (truncated) break
  }
  if (!streams) return { status: 'malformed' }
  const textFound = pieces.join('').replace(/^[\s\n]+/, '').length > 2
  if (!textFound) return { status: 'image_only' }
  if (truncated || failedStreams > 0) {
    const kept = pieces.join('').trim().slice(0, PDF_TEXT_CAP)
    return {
      status: 'partial',
      text: kept,
      note: truncated
        ? `Text was cut at the ${PDF_TEXT_CAP}-character read budget; what follows is the beginning only.`
        : `${failedStreams} of ${streams} content streams could not be decoded, so parts of the document are missing from this text.`,
    }
  }
  // Layout-fidelity guard: thousands of tiny fragments mean the extractor
  // flattened a table or CID-encoded text; the words are real, the order may
  // not be. Say so rather than implying a clean read.
  const joined = pieces.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, PDF_TEXT_CAP)
  if ((joined.match(/\S{1,2}\b/g) || []).length > 400) {
    return { status: 'partial', text: joined, note: 'This PDF encodes text in fragments (common for tables or embedded fonts), so wording is real but the order may be scrambled.' }
  }
  return { status: 'extracted', text: joined }
}

/** Decoded bytes to a bounded, status-labeled extraction. */
export function attachmentToText(meta: { mimeType: string; filename?: string }, bytes: Uint8Array): Extraction {
  if (bytes.byteLength === 0) return { status: 'empty' }
  if (bytes.byteLength > 15 * 1024 * 1024) return { status: 'too_large' }
  if (attachmentIsPdf(meta)) return extractPdfText(bytes)
  if (attachmentIsTextLike(meta)) {
    const text = Buffer.from(bytes).toString('utf-8')
    const head = text.slice(0, 2000)
    if (head.includes('\u0000')) return { status: 'unsupported' }
    const bad = (head.match(/\uFFFD/g) || []).length
    if (head.length > 0 && bad / head.length > 0.1) return { status: 'unsupported' }
    if (text.length > PDF_TEXT_CAP) {
      return { status: 'partial', text: text.slice(0, PDF_TEXT_CAP), note: `Cut at the ${PDF_TEXT_CAP}-character read budget; the beginning only.` }
    }
    return { status: 'extracted', text }
  }
  return { status: 'unsupported' }
}

export function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/* ---- Server-side fetchers ---- */

const FETCH_CAPS = { maxAttachmentBytes: 15 * 1024 * 1024, maxAttachments: 8 }

export async function loadGmailFullMessage(
  sql: SQL,
  userId: string,
  messageId: string,
): Promise<{
  ok: boolean
  status?: string
  message?: {
    subject: string
    from: string
    date: string
    to: string
    threadId: string
    snippet: string
    bodyText: string
    attachments: AttachmentMeta[]
  }
}> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return { ok: false, status: 'not_connected' }
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
      { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10_000) },
    )
    if (res.status === 401) return { ok: false, status: 'auth_expired' }
    if (res.status === 404) return { ok: false, status: 'not_found' }
    if (!res.ok) return { ok: false, status: 'provider_error' }
    const data = (await res.json()) as {
      snippet?: string
      threadId?: string
      payload?: GmailMimePart & { headers?: Array<{ name: string; value: string }> }
    }
    const headers = data.payload?.headers || []
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
    const { extractGmailBody } = await import('../gmailHelpers')
    const walked = extractGmailBody(data.payload)
    return {
      ok: true,
      message: {
        subject: h('subject'),
        from: h('from'),
        date: h('date'),
        to: h('to'),
        threadId: data.threadId || '',
        snippet: data.snippet || '',
        bodyText: walked.text,
        attachments: collectAttachments(data.payload),
      },
    }
  } catch {
    return { ok: false, status: 'timeout' }
  }
}

export async function fetchGmailAttachmentBytes(
  sql: SQL,
  userId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ ok: boolean; status?: string; bytes?: Uint8Array; size?: number }> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return { ok: false, status: 'not_connected' }
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(12_000) },
    )
    if (res.status === 401) return { ok: false, status: 'auth_expired' }
    if (!res.ok) return { ok: false, status: res.status === 404 ? 'not_found' : 'provider_error' }
    const data = (await res.json()) as { data?: string; size?: number }
    if (!data.data) return { ok: false, status: 'malformed_response' }
    const bytes = decodeAttachmentBytes(data.data)
    if (bytes.byteLength > FETCH_CAPS.maxAttachmentBytes) return { ok: false, status: 'too_large' }
    return { ok: true, bytes, size: bytes.byteLength }
  } catch {
    return { ok: false, status: 'timeout' }
  }
}

/**
 * One attachment, read and text-extracted, bound to its source message. The
 * result carries thread identity so "summarize the attachment" answers can
 * never be quoted without the email they came from.
 */
/** The user-facing note per extraction status — shared by the web reader and
 * the bot route so both never read a partial/unreadable result as complete. */
export function attachmentResponseNote(ex: Extraction, meta: { filename: string; mimeType: string; size: number }): string {
  switch (ex.status) {
    case 'extracted':
      return ''
    case 'partial':
      return `${meta.filename}: ${ex.note || 'partially extracted'} Summarize only what is here and say it is partial.`
    case 'unsupported':
      return `${meta.filename} is a ${meta.mimeType} file; its text cannot be extracted safely. Describe it by name and type; offer to forward it as-is.`
    case 'image_only':
      return `${meta.filename} looks like a scanned document (images, no text layer). It needs eyes on the page, not a text parse; offer to forward it or describe what the user already knows.`
    case 'encrypted':
      return `${meta.filename} is password-protected, so it cannot be read here. Say so plainly; never guess at the contents.`
    case 'malformed':
      return `${meta.filename} could not be parsed as a document. Say so; do not summarize.`
    case 'too_large':
      return `${meta.filename} is too large to read here (${meta.size} bytes). Say so; offer to forward it.`
    case 'empty':
      return `${meta.filename} is a zero-byte file.`
  }
}

export async function readGmailAttachment(
  sql: SQL,
  userId: string,
  messageId: string,
  attachmentId: string,
): Promise<{
  ok: boolean
  status?: string
  source?: { messageId: string; subject: string; from: string; threadId: string }
  meta?: { filename: string; mimeType: string; size: number }
  extraction?: Extraction
}> {
  const full = await loadGmailFullMessage(sql, userId, messageId)
  if (!full.ok || !full.message) return { ok: false, status: full.status }
  const meta = full.message.attachments.find((a) => a.attachmentId === attachmentId)
  if (!meta) return { ok: false, status: 'not_found' }
  const got = await fetchGmailAttachmentBytes(sql, userId, messageId, attachmentId)
  if (!got.ok || !got.bytes) return { ok: false, status: got.status }
  if (got.status === 'too_large') return { ok: false, status: 'too_large' }
  const extraction = attachmentToText(meta, got.bytes)
  return {
    ok: true,
    source: { messageId, subject: full.message.subject, from: full.message.from, threadId: full.message.threadId },
    meta: { filename: meta.filename || '(unnamed)', mimeType: meta.mimeType, size: got.bytes.byteLength },
    extraction,
  }
}
