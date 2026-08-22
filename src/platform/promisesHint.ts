export type PromiseItem = { title: string; dueAt?: string | null; status?: string }

/** Ranking and labelling only ever read the due date, so they accept anything dated. */
type DatedItem = { dueAt?: string | null }

function dueDay(iso: string | null | undefined) {
  return iso ? iso.slice(0, 10) : null
}

export function rankPromise(l: DatedItem, today: string) {
  const d = dueDay(l.dueAt)
  if (!d) return 2
  if (d < today) return 0
  if (d === today) return 1
  return 3
}

export function promiseDueLabel(l: DatedItem, today: string) {
  const d = dueDay(l.dueAt)
  if (!d) return 'no date'
  if (d < today) return 'overdue'
  if (d === today) return 'due today'
  return 'later'
}

export function promisesHubHint(open: PromiseItem[], today: string) {
  const ranked = open
    .filter((l) => l.status !== 'done' && l.status !== 'snoozed')
    .slice()
    .sort((a, b) => rankPromise(a, today) - rankPromise(b, today))
  if (!ranked.length) return 'Catch what you told someone you would do'
  const first = ranked[0]!
  const due = promiseDueLabel(first, today)
  const title = first.title.trim()
  if (ranked.length === 1) return due === 'later' || due === 'no date' ? title : `${title}  ${due}`
  return `${title}  and ${ranked.length - 1} more`
}
