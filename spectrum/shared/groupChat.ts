/**
 * Group threads. The channel supports them (the iMessage provider's space
 * schema carries `type: "dm" | "group"`, `space.create` builds a group from
 * participants, and `addMembers` is documented as "remote + group only"), so
 * the reason Alpha does not yet coordinate a group is our code, not the
 * platform. This module is the first step: know when the thread is a group,
 * know who is speaking, and answer with the right manners.
 *
 * What it deliberately does NOT do yet: poll the members, reconcile answers and
 * book on the group's behalf. That is the coordination half of the dimension
 * and it needs its own design (who may speak for the group, what the other
 * members see).
 */

export type SpaceParticipant = { id?: string; name?: string; address?: string }

export type GroupTurnContext = {
  /** The provider's space type. Anything other than 'group' is a DM. */
  spaceType?: string
  /** Members when the provider exposes them. */
  members?: SpaceParticipant[]
  /** The speaking member. */
  speakerId?: string
  speakerName?: string
}

/** True only when the provider says so — never inferred from member count,
 * because a one-member list is a DM that happened to carry an array. */
export function isGroupSpace(spaceType?: string): boolean {
  return String(spaceType || '').toLowerCase() === 'group'
}

function nameFor(ctx: GroupTurnContext): string {
  const direct = String(ctx.speakerName || '').trim()
  if (direct) return direct
  const id = String(ctx.speakerId || '').trim()
  const match = ctx.members?.find((m) => m.id === id || m.address === id)
  const fromList = String(match?.name || '').trim()
  if (fromList) return fromList
  return id || 'someone in the group'
}

/**
 * The instruction a group turn carries, or null for a DM. Written as one
 * paragraph because it rides in the same extras block as every other turn
 * note, and the privacy clause is the load-bearing part: the account owner's
 * mail, calendar, location and memories must not surface to the other members
 * just because the owner added Alpha to a thread.
 */
export function groupTurnNote(ctx: GroupTurnContext): string | null {
  if (!isGroupSpace(ctx.spaceType)) return null
  const speaker = nameFor(ctx)
  const others = (ctx.members || []).filter((m) => m.id && m.id !== ctx.speakerId).length
  const size = others > 0 ? `a group of about ${others + 1}` : 'a group chat'
  return [
    `This message is from ${speaker} in ${size} — not a one to one thread.`,
    `Reply to the group, and address ${speaker} by name when you answer them.`,
    'Never assume another member is the account holder, and never share the account holder\'s mail, calendar, location, budget or memories with the group.',
    'Anything that needs the account (a booking, a payment, a private calendar slot) goes to the account holder in a direct message, not to the group, and say that plainly.',
  ].join(' ')
}
