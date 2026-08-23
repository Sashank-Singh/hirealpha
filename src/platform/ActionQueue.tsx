/* ---- One action layer, shared by every surface that ranks work ----
 * `NextItem` was already the vocabulary Next spoke; this module is the verbs that
 * go with it. Before this, three separate pickers answered "what should you do
 * next" and only one of them could actually do it — Next dispatched across seven
 * backends while home rendered a link and the brief's lead card rendered a link.
 *
 * Keeping the dispatcher here means a surface earns a working Do button by
 * emitting a `NextItem`, not by re-implementing seven API calls.
 */

import { Link } from 'react-router-dom'
import {
  apiHoldSlot,
  apiLinearAction,
  apiPatchLoop,
  apiPatchPipeline,
  apiRsvpEvent,
  apiSendDraft,
  apiTouchNetwork,
  type NextItem,
} from './api'
import type { FeatureAuth } from './FeatureMiniApps'

/** Just the credentials — every action endpoint takes exactly this. */
export type ActionAuth = Pick<FeatureAuth, 'email' | 'token' | 'persona'>

/**
 * Where an `open` item points. `suffix` carries the caller's query string onto
 * paths this builds — mini-app links are token-only, so a friend's row that lost
 * `?t=…` would land on a login wall. An absolute `item.href` is left alone; it
 * already knows its own query.
 */
export function itemHref(persona: string, item: NextItem, suffix = '') {
  if (item.href) return item.href
  if (item.openKind) return `/app/mini/${persona}/${item.openKind}${suffix}`
  return ''
}

/**
 * Do the thing. Throws with a message worth showing when a backend says no;
 * an item whose verb is `open` (or which is missing the id its verb needs) is a
 * no-op here, because the control for those is a link, not a button.
 */
export async function runAction(item: NextItem, a: ActionAuth): Promise<void> {
  if (item.action === 'send' && item.draftId) {
    const res = await apiSendDraft({ ...a, id: item.draftId })
    if (!res.ok) throw new Error(res.error || 'Send failed. Connect Gmail.')
  } else if (item.action === 'hold' && item.start && item.end) {
    const res = await apiHoldSlot({ ...a, title: item.title, start: item.start, end: item.end })
    if (!res.ok) throw new Error(res.error || 'Could not hold that time.')
  } else if (item.action === 'loop' && item.loopId) {
    await apiPatchLoop({ ...a, id: item.loopId, status: 'done' })
  } else if (item.action === 'person' && item.personId) {
    await apiTouchNetwork({ ...a, id: item.personId, context: item.hint })
  } else if (item.action === 'linear' && item.issueId) {
    const res = await apiLinearAction({ ...a, id: item.issueId, action: 'later' })
    if (!res.ok) throw new Error(res.error || 'Linear did not update.')
  } else if (item.action === 'rsvp' && item.eventId) {
    const res = await apiRsvpEvent({ ...a, eventId: item.eventId, response: 'accepted' })
    if (!res.ok) throw new Error(res.error || 'Could not RSVP.')
  } else if (item.action === 'pipeline' && item.pipelineId && item.stage) {
    await apiPatchPipeline({ ...a, id: item.pipelineId, stage: item.stage })
  }
}

/**
 * Push it out of the way. A promise has a real due date to move, so moving it is
 * durable; everything else just goes to the back of this list, which is why the
 * caller is told which of the two happened.
 */
export async function snoozeAction(item: NextItem, a: ActionAuth): Promise<'reload' | 'rotate'> {
  if (item.action === 'loop' && item.loopId) {
    const due = new Date()
    due.setDate(due.getDate() + 1)
    await apiPatchLoop({ ...a, id: item.loopId, status: 'open', dueAt: due.toISOString() })
    return 'reload'
  }
  return 'rotate'
}

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
          {item.doLabel || 'Text'}
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
