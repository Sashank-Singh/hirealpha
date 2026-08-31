import type { NextItem } from './api'
import {
  apiHoldSlot,
  apiLinearAction,
  apiPatchLoop,
  apiPatchPipeline,
  apiRsvpEvent,
  apiSendDraft,
  apiTouchNetwork,
} from './api'

/** Just the credentials — every action endpoint takes exactly this. */
export type ActionAuth = {
  email?: string
  token?: string
  persona: string
}

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
