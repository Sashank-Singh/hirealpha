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
