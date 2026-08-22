import { useEffect, useState } from 'react'
import type { MailMessage } from './api'
import { apiGetMailMessage } from './api'

/** Strip dangerous HTML constructs from an email body before rendering. */
function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*/gi, '<noembed')
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'href="#"')
    .replace(/src\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'src=""')
}

/** Format a date header into a short readable string. */
function fmtEmailDate(raw: string | undefined): string {
  if (!raw) return ''
  try {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return raw.slice(0, 32)
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return raw.slice(0, 32)
  }
}

/** Strip angle-bracket address: "Name <email@x.com>" → "Name". */
function fmtEmailFrom(raw: string | undefined): string {
  if (!raw) return ''
  const name = raw.replace(/<[^>]+>/g, '').trim()
  return name || raw
}

const EMAIL_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: ' ',
  apos: "'",
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => EMAIL_ENTITIES[String(name).toLowerCase()] ?? m)
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
    .replace(/(\b[\w.-]+\.[a-z]{2,}(?:\/\S*)?)<(https?:\/\/[^>]+)>/gi, '$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
}

interface EmailReaderProps {
  messageId: string
  /** Fallback label shown while loading */
  label?: string
  /** Gmail snippet shown while the body loads */
  summary?: string
  auth: { email?: string; token?: string }
  persona?: string
  onClose: () => void
}

export function EmailReader({ messageId, label, summary, auth, persona, onClose }: EmailReaderProps) {
  const [msg, setMsg] = useState<MailMessage | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    apiGetMailMessage({ ...auth, messageId })
      .then((d) => { if (!cancelled) setMsg(d) })
      .catch(() => { if (!cancelled) setMsg({ ok: false, error: 'Could not load message.' }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [messageId])

  const sanitizedHtml = msg?.ok && msg.bodyHtml ? sanitizeEmailHtml(msg.bodyHtml) : ''
  const bodyText = msg?.ok ? (msg.bodyText || '') : ''
  const connectHref = `/app/hires/${persona || 'friend'}`

  return (
    <div className="email-reader-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="email-reader" onClick={(e) => e.stopPropagation()}>
        <button className="email-reader-close" type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>

        {loading && (
          <div className="email-reader-loading-block">
            <p className="mini__blurb email-reader-loading">Loading message…</p>
            {summary ? (
              <>
                <p className="email-reader-kicker">Summary</p>
                <p className="email-reader-text">{summary}</p>
              </>
            ) : null}
          </div>
        )}

        {!loading && msg && !msg.ok && (
          <div className="email-reader-err">
            <p className="mini__blurb">{msg.error || 'Could not load message.'}</p>
            {(msg.error || '').toLowerCase().includes('not connected') && (
              <a className="ma-btn email-reader-connect" href={connectHref}>
                Connect Gmail in Settings
              </a>
            )}
            {label && <p className="email-reader-fallback-label">{label}</p>}
          </div>
        )}

        {!loading && msg?.ok && (
          <div className="email-reader-content">
            <h3 className="email-reader-subject">{msg.subject || '(no subject)'}</h3>
            <div className="email-reader-meta">
              <span className="email-reader-from">{fmtEmailFrom(msg.from)}</span>
              {msg.date && (
                <span className="email-reader-date">{fmtEmailDate(msg.date)}</span>
              )}
            </div>
            {sanitizedHtml ? (
              <div
                className="email-reader-html"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
                dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
              />
            ) : bodyText ? (
              <pre className="email-reader-text">{cleanEmailBody(bodyText)}</pre>
            ) : msg.snippet ? (
              <p className="email-reader-text">{cleanEmailBody(msg.snippet)}</p>
            ) : (
              <p className="mini__empty">No body content.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
