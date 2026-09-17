import type { BriefMailGroup } from './briefStory'

/* Rows the server minted from a text-only mail scan carry `text-N` instead of a
 * Gmail id. They can be listed and dismissed, but there is no message behind
 * them to open or draft a reply to, so nothing that needs the message is
 * offered on one. */
export function isOpenableMail(id: string | undefined): boolean {
  return !!id && !id.startsWith('text-')
}

/** True when the brief's mail is that text-only scan rather than real rows. */
export function mailScanOnlyFrom(groups: BriefMailGroup[] | undefined): boolean {
  const items = (groups || []).find((g) => g.kind === 'reply')?.items || []
  return items.length > 0 && items.every((m) => !isOpenableMail(m.id))
}
