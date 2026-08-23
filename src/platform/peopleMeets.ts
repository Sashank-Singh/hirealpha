const STAY_RE =
  /\b(hotel|stay|check[- ]?in|check[- ]?out|flight|airport|ooo|out of office|vacation|holiday|layover|transit|airbnb|bnb|depart|arrives?|arrival|departure|cruise|resort|inn|motel|lodge)\b/i

const NOT_A_PERSON =
  /^(stay|staying|hotel|flight|airport|ooo|busy|blocked|hold|focus|deep work|lunch|dinner|gym|workout|commute|travel|transit|check[- ]?in|check[- ]?out|meeting|meet|call|standup|sync)$/i

export function isTravelOrStayTitle(title: string, place = ''): boolean {
  const t = String(title || '').trim()
  if (!t && !place) return false
  if (/^stay\b/i.test(t)) return true
  return STAY_RE.test(`${t} ${place}`)
}

export function isPersonMeetSuggestion(e: {
  who?: string
  title: string
  time?: string
  place?: string
  allDay?: boolean
}): boolean {
  if (e.allDay || /^all day$/i.test(String(e.time || '').trim())) return false
  const who = String(e.who || '').trim()
  const title = String(e.title || '').trim()
  const place = String(e.place || '').trim()
  if (isTravelOrStayTitle(title, place) || isTravelOrStayTitle(who, place)) return false
  const name = who || title
  if (!name || NOT_A_PERSON.test(name)) return false
  if (/\b(hotel|inn|motel|resort|lodge|airbnb)\b/i.test(name)) return false
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length > 5) return false
  return true
}

export function stayWhereFrom(title: string, place: string) {
  const hotel = place || title.replace(/^(stay(?:ing)?(?:\s+at)?)\s+/i, '').trim()
  return { title: hotel || title, place: place || hotel }
}

/** The cadence presets a person can be reach-out'd on, in days. */
export const CADENCE_OPTIONS = [
  { days: 7, label: 'Every week' },
  { days: 14, label: 'Every 2 weeks' },
  { days: 30, label: 'Every month' },
  { days: 60, label: 'Every 2 months' },
  { days: 180, label: 'Every 6 months' },
  { days: 365, label: 'Every year' },
] as const

/** Human words for a cadence, so "every 180d" reads like a person said it. */
export function cadenceLabel(days: number): string {
  const hit = CADENCE_OPTIONS.find((o) => o.days === days)
  if (hit) return hit.label.toLowerCase()
  if (days < 30) return `every ${Math.max(1, Math.round(days))} days`
  return `every ${Math.round(days)} days`
}
