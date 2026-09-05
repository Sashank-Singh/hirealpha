/* ---- One action layer, shared by every surface that ranks work ----
 * The verbs (`runAction`, `snoozeAction`, `itemHref`) live in `actionRunner.ts`
 * so this file stays components-only and fast-refresh stays granular.
 *
 * Keeping the dispatcher in one module means a surface earns a working Do button
 * by emitting a `NextItem`, not by re-implementing seven API calls.
 */

import { Link } from 'react-router-dom'
import { type NextItem } from './api'
import { itemHref } from './actionRunner'

type ButtonProps = {
  item: NextItem
  persona: string
  /** Query string to keep on links, e.g. `?t=<token>`. */
  suffix?: string
  busy?: boolean
  done?: boolean
  /** Class for the primary control, so a hero and a row can look different. */
  btnClass?: string
  chipClass?: string
  onDo: (item: NextItem) => void
  onSnooze?: (item: NextItem) => void
  onOpenMail?: (item: NextItem) => void
}

/** The control cluster for a lead item: read it, text it, open it, or do it. */
export function ActionButtons({
  item,
  persona,
  suffix,
  busy,
  done,
  btnClass = 'ma-btn',
  chipClass = 'ma-chip',
  onDo,
  onSnooze,
  onOpenMail,
}: ButtonProps) {
  const href = itemHref(persona, item, suffix)
  return (
    <>
      {item.messageId && onOpenMail && (
        <button className={btnClass} type="button" onClick={() => onOpenMail(item)}>
          Read
        </button>
      )}
      {item.sms && (
        <a className={btnClass} href={item.sms}>
          Text
        </a>
      )}
      {!item.sms && !item.messageId && href && item.action === 'open' && (
        <Link className={btnClass} to={href}>
          {item.doLabel || 'Open'}
        </Link>
      )}
      {item.action !== 'open' && !item.messageId && (
        <button className={btnClass} type="button" disabled={busy} onClick={() => onDo(item)}>
          {done ? 'Done' : item.doLabel || 'Do'}
        </button>
      )}
      {onSnooze && (
        <button className={chipClass} type="button" disabled={busy} onClick={() => onSnooze(item)}>
          Snooze
        </button>
      )}
    </>
  )
}

type RowProps = {
  item: NextItem
  persona: string
  suffix?: string
  busy?: boolean
  done?: boolean
  onDo: (item: NextItem) => void
  onOpenMail?: (item: NextItem) => void
}

/**
 * One queued item below the lead. Mail is the exception: the whole row opens the
 * reader, because a mail row has nothing to do until you have read it.
 */
export function ActionRow({ item, persona, suffix, busy, done, onDo, onOpenMail }: RowProps) {
  const isMail = !!item.messageId && !!onOpenMail
  const open = () => onOpenMail?.(item)
  const href = itemHref(persona, item, suffix)
  return (
    <li
      className={`ma-row${isMail ? ' mail-row' : ''}${done ? ' ma-row--done' : ''}`}
      onClick={isMail ? open : undefined}
      role={isMail ? 'button' : undefined}
      tabIndex={isMail ? 0 : undefined}
      onKeyDown={
        isMail
          ? (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') open()
            }
          : undefined
      }
    >
      <div className="ma-row-main">
        <span className="ma-title">{item.title}</span>
        <span className="ma-sub">
          {item.kicker}
          {item.hint ? ` · ${item.hint}` : ''}
        </span>
      </div>
      {!isMail && item.action === 'open' && href && (
        <Link className="ma-chip" to={href}>
          {item.doLabel || 'Open'}
        </Link>
      )}
      {!isMail && item.action !== 'open' && (
        <button className="ma-chip" type="button" disabled={busy} onClick={() => onDo(item)}>
          {done ? 'Done' : item.doLabel || 'Do'}
        </button>
      )}
    </li>
  )
}
