import { useEffect, useState, type FormEvent } from 'react'
import type { MailMessage, ReplyDraft } from './api'
import { apiGetMailMessage, apiRewriteDraft, apiSendDraft } from './api'

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

/** Quick ways to have Alpha rework the reply; each maps to a natural instruction. */
const ASK_CHIPS = [
  { label: 'Shorter', instruction: 'Make it shorter' },
  { label: 'More formal', instruction: 'Make it more formal' },
  { label: 'Warmer', instruction: 'Make it warmer and friendlier' },
  { label: 'Add a question', instruction: 'Add a closing question' },
]

interface EmailReaderProps {
  messageId: string
  /** Fallback label shown while loading */
  label?: string
  /** Gmail snippet shown while the body loads */
  summary?: string
  auth: { email?: string; token?: string }
  persona?: string
  /** A generated reply to review: when present, a compose panel renders below the message. */
  draft?: ReplyDraft | null
  onClose: () => void
}

export function EmailReader({ messageId, label, summary, auth, persona, onClose, draft }: EmailReaderProps) {
  const [msg, setMsg] = useState<MailMessage | null>(null)
  const [loading, setLoading] = useState(true)
  const [to, setTo] = useState(draft?.toAddr || '')
  const [subject, setSubject] = useState(draft?.subject || '')
  const [body, setBody] = useState(draft?.body || '')
  const [busy, setBusy] = useState(false)
  const [composeMsg, setComposeMsg] = useState('')
  const [askText, setAskText] = useState('')
  const [adjustBusy, setAdjustBusy] = useState(false)
  const [adjustMsg, setAdjustMsg] = useState('')
  const [newMail, setNewMail] = useState(false)
  const [newTo, setNewTo] = useState('')
  const [newSubject, setNewSubject] = useState('')
  const [newBody, setNewBody] = useState('')
  const [newBusy, setNewBusy] = useState(false)
  const [newMsg, setNewMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    apiGetMailMessage({ ...auth, messageId })
      .then((d) => { if (!cancelled) setMsg(d) })
      .catch(() => { if (!cancelled) setMsg({ ok: false, error: 'Could not load message.' }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [messageId])

  // A different message's draft arriving should reset the composer, not leave
  // stale text behind.
  useEffect(() => {
    if (!draft) return
    setTo(draft.toAddr)
    setSubject(draft.subject)
    setBody(draft.body)
    setComposeMsg('')
    setAdjustMsg('')
    setAskText('')
  }, [draft])

  async function adjust(raw: string) {
    const instruction = raw.trim()
    if (!instruction || adjustBusy || !draft) return
    setAdjustBusy(true)
    setAdjustMsg('')
    try {
      const res = await apiRewriteDraft({ ...auth, id: draft.id, instruction })
      if (!res.ok) throw new Error(res.error || 'Alpha could not adjust it right now.')
      setBody(res.body)
      setAskText('')
      setAdjustMsg('Updated.')
    } catch (err) {
      setAdjustMsg(err instanceof Error ? err.message : 'Could not adjust.')
    } finally {
      setAdjustBusy(false)
    }
  }

  async function sendReply(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setComposeMsg('')
    try {
      const res = await apiSendDraft({
        ...auth,
        id: draft?.id,
        toAddr: to.trim(),
        subject: subject.trim(),
        body,
      })
      if (!res.ok) throw new Error(res.error || 'Send failed. Reconnect Gmail with send access.')
      onClose()
    } catch (err) {
      setComposeMsg(err instanceof Error ? err.message : 'Could not send.')
    } finally {
      setBusy(false)
    }
  }

  async function sendNewEmail(e: FormEvent) {
    e.preventDefault()
    if (newBusy) return
    setNewBusy(true)
    setNewMsg('')
    try {
      const res = await apiSendDraft({ ...auth, toAddr: newTo.trim(), subject: newSubject.trim(), body: newBody })
      if (!res.ok) throw new Error(res.error || 'Send failed. Reconnect Gmail with send access.')
      setNewTo('')
      setNewSubject('')
      setNewBody('')
      setNewMail(false)
    } catch (err) {
      setNewMsg(err instanceof Error ? err.message : 'Could not send.')
    } finally {
      setNewBusy(false)
    }
  }

  const sanitizedHtml = msg?.ok && msg.bodyHtml ? sanitizeEmailHtml(msg.bodyHtml) : ''
  const bodyText = msg?.ok ? (msg.bodyText || '') : ''
  const connectHref = `/app/hires/${persona || 'friend'}`

  return (
    <div className="email-reader-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="email-reader" onClick={(e) => e.stopPropagation()}>
        <button className="email-reader-close" type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <button className="email-reader-compose" type="button" onClick={() => setNewMail(true)}>
          ＋ Send email
        </button>

        {newMail && (
          <form className="reply-compose" onSubmit={sendNewEmail}>
            <h4 className="reply-compose-title">New email</h4>
            <input
              className="mini__input"
              value={newTo}
              onChange={(e) => setNewTo(e.target.value)}
              placeholder="To"
              aria-label="To"
            />
            <input
              className="mini__input"
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              placeholder="Subject"
              aria-label="Subject"
            />
            <textarea
              className="mini__textarea"
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              placeholder="Write your email…"
              aria-label="Body"
            />
            <div className="reply-compose-actions">
              <button className="mini__btn" type="submit" disabled={newBusy || !newTo.trim() || !newSubject.trim()}>
                {newBusy ? 'Sending…' : 'Send email'}
              </button>
              <button className="mini__btn reply-compose-cancel" type="button" onClick={() => setNewMail(false)} disabled={newBusy}>
                Cancel
              </button>
            </div>
            {newMsg && <p className="reply-compose-msg">{newMsg}</p>}
          </form>
        )}

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

        {draft && (
          <>
            <form className="reply-compose" onSubmit={sendReply}>
              <h4 className="reply-compose-title">Reply draft</h4>
            <input
              className="mini__input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="To"
              aria-label="To"
            />
            <input
              className="mini__input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              aria-label="Subject"
            />
            <textarea
              className="mini__textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your reply…"
              aria-label="Reply body"
            />
            <div className="reply-compose-actions">
              <button className="mini__btn" type="submit" disabled={busy || !to.trim() || !subject.trim()}>
                {busy ? 'Sending…' : 'Send draft'}
              </button>
              <button className="mini__btn reply-compose-cancel" type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
            {composeMsg && <p className="reply-compose-msg">{composeMsg}</p>}
          </form>
          <div className="reply-ask">
            <div className="reply-ask-chips">
              {ASK_CHIPS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className="reply-ask-chip"
                  disabled={adjustBusy}
                  onClick={() => adjust(c.instruction)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="reply-ask-row">
              <input
                className="mini__input"
                value={askText}
                onChange={(e) => setAskText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    adjust(askText)
                  }
                }}
                placeholder="Ask Alpha to adjust…"
                aria-label="Ask Alpha to adjust the draft"
              />
              <button
                className="mini__btn"
                type="button"
                disabled={adjustBusy || !askText.trim()}
                onClick={() => adjust(askText)}
              >
                {adjustBusy ? 'Adjusting…' : 'Adjust'}
              </button>
            </div>
            {adjustMsg && <p className="reply-ask-msg">{adjustMsg}</p>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
