/* Mail bodies arrive as whatever the sender's client produced. A real message
 * is a mix of mail-merge plain text (markdown asterisks, "<https://…>" autolink
 * wrappers, tracking redirects wrapped around the real link) and hard-wrapped
 * lines that were only ever meant to be one paragraph. These helpers clean that
 * into something that reads like a person wrote it. Kept out of EmailReader so
 * they can be tested without mounting React. */

const EMAIL_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: ' ',
  apos: "'",
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => EMAIL_ENTITIES[String(name).toLowerCase()] ?? m)
}

/* Query params that hold the real destination behind a click wrapper. Mail
 * chips (Mailchimp, mail-merge tools, Outlook SafeLinks) bury the link the
 * sender meant inside one of these, which is why a body can show a 300
 * character appspot.com URL for a job post. */
const TRACK_PARAMS = [
  'url',
  'u',
  'redirect',
  'redirect_uri',
  'redirect_url',
  'target',
  'link',
  'dest',
  'destination',
  'continue',
]

/** The destination inside a redirect wrapper, or the URL unchanged. */
export function unwrapTrackingUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    for (const key of TRACK_PARAMS) {
      let cand = u.searchParams.get(key)
      if (!cand) continue
      for (let i = 0; i < 2 && !/^https?:\/\//i.test(cand); i++) {
        try {
          cand = decodeURIComponent(cand)
        } catch {
          break
        }
      }
      if (/^https?:\/\//i.test(cand)) return cand
    }
  } catch {
    /* not an absolute URL — show it as sent */
  }
  return rawUrl
}

/** Display text for a link: no scheme, tracking params dropped, long paths cut. */
export function prettyUrl(rawUrl: string): string {
  const url = unwrapTrackingUrl(rawUrl)
  let bare = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  const q = bare.indexOf('?')
  if (q !== -1) {
    const [head, query] = [bare.slice(0, q), bare.slice(q + 1)]
    const kept = query
      .split('&')
      .filter((p) => p && !/^(?:utm_|fbclid|gclid|mc_cid|mc_eid|kev)/i.test(p))
    bare = kept.length ? `${head}?${kept.join('&')}` : head
  }
  if (bare.length <= 52) return bare
  const slash = bare.indexOf('/')
  if (slash === -1) return `${bare.slice(0, 51)}…`
  const host = bare.slice(0, slash)
  const tail = bare.slice(slash + 1).split(/[?#]/)[0]!
  const last = tail.split('/').filter(Boolean).pop() || ''
  if (!last) return `${host}/…`
  const short = last.length > 20 ? `${last.slice(0, 19)}…` : last
  return `${host}/…/${short}`
}

/** Tags that mean the body was designed as HTML, not just wrapped in a div. */
const RICH_HTML = /<(?:a|img|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|blockquote|hr|strong|em|b|i|font|span\s+style)\b/i

/** True when an HTML body is really plain text wearing a wrapper element. */
export function htmlIsPlainText(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, '').trim()
  if (!text) return false
  if (RICH_HTML.test(html)) return false
  const blocks = html.match(/<(?:div|section|center|p)\b/gi)?.length ?? 0
  return blocks < 2
}

/** Strip tags but keep the line breaks they implied, for text rendering. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
}

/**
 * Plain-text mail arrives full of client artifacts: inline image refs, URLs the
 * client already linkified wrapped in angle brackets, HTML entities, and the
 * double blank lines Outlook inserts between every paragraph. Clean those so a
 * thread reads like something a person wrote.
 */
export function cleanEmailBody(text: string): string {
  return decodeEntities(text)
    .replace(/\[cid:[^\]]+\]/g, '')
    // "<https://x>" is how plain-text parts spell a link — the brackets are the
    // client's, not the sender's, and they stop the linkifier below from seeing it.
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/(\b[\w.-]+\.[a-z]{2,}(?:\/\S*)?)<(https?:\/\/[^>]+)>/gi, '$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
}

const STRUCTURED_LINE = /^(?:[-*•]|\d+[.)]|>|#{1,4}\s)/
const ENDS_SENTENCE = /[.!?…:;]$/
/** Roughly where a mail client wraps. Shorter lines are deliberate breaks. */
const WRAP_MIN = 56

/**
 * Rejoin lines a client hard-wrapped mid-sentence. Only joins when the next
 * line starts lowercase, or the previous one runs to wrap width and stops
 * without punctuation — so addresses, signature blocks, and headers survive.
 */
export function joinWrappedLines(lines: string[]): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      out.push('')
      continue
    }
    const idx = out.length - 1
    const prev = idx >= 0 ? out[idx]! : ''
    if (!prev || STRUCTURED_LINE.test(line) || /^>/.test(prev) || /https?:\/\/\S+$/.test(prev)) {
      out.push(line)
      continue
    }
    const startsLower = /^[a-z(]/.test(line)
    const wrapped = prev.length >= WRAP_MIN && !ENDS_SENTENCE.test(prev)
    if (startsLower || wrapped) out[idx] = `${prev} ${line}`
    else out.push(line)
  }
  return out
}

/** Plain-text emails read as a wall of markdown. Escape, then lift the common
 * shapes — bold, italics, links, bullets, quotes, headings — into real HTML so
 * the reader renders them like a person wrote them. Everything else stays text. */
export function renderRichText(raw: string): string {
  // Escapes without doubling: an existing entity ("&amp;", "&#39;") is already
  // how the character is spelled, so only bare ampersands get wrapped. That
  // makes the links below — whose hrefs are rewritten after escaping — safe to
  // run through here twice.
  const esc = (v: string) =>
    v
      .replace(/&(?![a-zA-Z#][a-zA-Z0-9]{0,6};)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  const cleanUrl = (href: string) => {
    const bare = href.replace(/(?:&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)+$/i, '')
    return unwrapTrackingUrl(bare.replace(/[,.;:]+$/, ''))
  }
  const anchor = (href: string, label: string) =>
    `<a href="${esc(cleanUrl(href))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
  const inline = (v: string) =>
    esc(v)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text, href) => anchor(href, text))
      .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)"']+)/g, (_m, pre, url) => `${pre}${anchor(url, prettyUrl(url))}`)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      // "*About Micro1:*" — a single asterisk pair around a label, which is how
      // mail-merge plain text carries the emphasis from the HTML version.
      .replace(/(^|[\s(*])\*(\S(?:[^*\n]*\S)?)\*(?=[\s.,:;!?)]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s*_])_([^_\n]+)_(?=[\s.,!?]|$)/g, '$1<em>$2</em>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  const out: string[] = []
  let inList = false
  let inQuote = false
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false } }
  // Reply chains (On … wrote: + the quoted block after) and trailing
  // signature blocks add noise, not content. The opening message is what the
  // reader is for; drop everything after a quoted-header line.
  const bodyLines = cleanEmailBody(raw).split('\n')
  let cut = bodyLines.length
  for (let i = 0; i < bodyLines.length; i++) {
    const t = bodyLines[i]!.trim()
    if (/^On\b.+\bwrote:$/i.test(t) || /^[_-]{2,}\s*(from:)/i.test(t) || /^>\s{0,3}On .+wrote:$/i.test(t)) {
      cut = i
      break
    }
  }
  const lines = joinWrappedLines(bodyLines.slice(0, cut))
  for (const line of lines) {
    const t = line.trim()
    if (!t) { closeList(); closeQuote(); continue }
    // Quoted-forwarded lines inside the opening message get dimmed, not dropped.
    if (/^>/.test(t)) {
      out.push('<p class="emq">' + inline(t.replace(/^>\s*/, '')) + '</p>')
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t)
    if (h) { closeList(); closeQuote(); out.push(`<strong class="rt-h">${inline(h[2])}</strong>`); continue }
    const li = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(t)
    if (li) {
      closeQuote()
      if (!inList) { out.push('<ul class="rt-list">'); inList = true }
      out.push(`<li>${inline(li[1])}</li>`)
      continue
    }
    const q = /^>\s?(.*)$/.exec(t)
    if (q) {
      closeList()
      if (!inQuote) { out.push('<blockquote class="rt-quote">'); inQuote = true }
      out.push(`<div>${inline(q[1])}</div>`)
      continue
    }
    closeList(); closeQuote()
    out.push(`<p class="rt-p">${inline(t)}</p>`)
  }
  closeList(); closeQuote()
  return out.join('')
}
