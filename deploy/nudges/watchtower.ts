import {
  classifyBriefMail,
  scoreMail,
  isNoiseMail,
  mailHasDeadline,
  senderKey,
  type SenderSignal,
} from '../gmailHelpers'

export const AIRLINE_CODE_RE =
  /\b(?:UA|AA|DL|WN|AS|B6|NK|F9|HA|AC|BA|LH|AF|KL|EK|QF|SQ|CX|JL|NH|TK|IB|AZ|VS|FR|U2|ET|QR|EY|SN|OS|LX|AY|TP|SK|NZ|WS|PD|AM|LA|AV|CM|G3|AD)\s?\d{1,4}\b/
export const FLIGHT_WORD_RE = /\b(?:flight|airlines?|airways|boarding|departure|departs|nonstop|non-stop)\b/i
export const CONFIRM_URL_RE = /https?:\/\/[^\s<>"')]+/i

export type FlightEventHit = {
  airline?: string
  flight?: string
  /** Departure instant as ISO. */
  departAt: string
  /** Confirmation/check-in URL when the event carries one. */
  confirmationUrl?: string
  destination?: string
}

/** Pull a flight out of one calendar event. Title wins over description for
 * the carrier code; destination is the last "to X" / location tail. */
export function extractFlightEvent(item: {
  title: string
  description?: string
  location?: string
  start: Date
  allDay?: boolean
}): FlightEventHit | null {
  if (Number.isNaN(item.start.getTime())) return null
  if (item.allDay) return null
  const title = String(item.title || '').trim()
  const desc = String(item.description || '')
  const loc = String(item.location || '')
  const codeMatch = title.match(AIRLINE_CODE_RE) || desc.match(AIRLINE_CODE_RE)
  const blob = `${title} ${desc} ${loc}`
  if (!codeMatch) {
    // Without a carrier code an event needs a flight signal AND a second
    // signal: a bare "flight" is not enough ("Flight of the Conchords" is a
    // concert), and a bare route or terminal is not either.
    const flightWord = FLIGHT_WORD_RE.test(blob)
    const airportWord = /\b(?:airport|terminal|gate)\b/i.test(blob)
    const route = /\b(?:to|from)\s+[A-Za-z][A-Za-z .'-]{2,30}\b/.test(`${title} ${loc}`)
    if (!flightWord && !airportWord) return null
    if (!route && !airportWord) return null
  }
  const flight = codeMatch ? codeMatch[0].replace(/\s+/, ' ').toUpperCase() : undefined
  const airline = flight ? flight.split(/\s+/)[0] : undefined
  const urlMatch = `${desc} ${loc}`.match(CONFIRM_URL_RE)
  const destMatch = `${title} ${loc}`.match(/\bto\s+([A-Za-z][A-Za-z .'-]{2,30})\b/)
  return {
    ...(airline ? { airline } : {}),
    ...(flight ? { flight } : {}),
    departAt: item.start.toISOString(),
    ...(urlMatch ? { confirmationUrl: urlMatch[0] } : {}),
    ...(destMatch ? { destination: destMatch[1]!.trim() } : {}),
  }
}

export const WATCHTOWER_REGEX_BAR = 70
export const WATCHTOWER_JUDGE_BAR = 70
export const WATCHTOWER_URGENT_SCORE = 90
export const WATCHTOWER_MIN_HOURS_BETWEEN_PINGS = 20

export const TRAVEL_CONFIRM_RE =
  /\b(confirmation\s*(code|number|#)|booking\s*(ref|reference|confirmation)|itinerary|e-?ticket|boarding\s*pass|reservation\s*(confirmed|number)|check-?in\s*(is\s*(open|available)|reminder))\b/i

export function isTravelConfirmation(m: { from: string; subject: string; snippet?: string }): boolean {
  return TRAVEL_CONFIRM_RE.test(`${m.from || ''} ${m.subject || ''} ${m.snippet || ''}`)
}

export type WatchtowerCandidate = {
  id: string
  from: string
  subject: string
  snippet: string
  kind: string
  score: number
  reasons: string[]
}

/** Free first gate: drop noise and already-pinged mail, keep only high-score
 * actionable or travel mail. Pure — pinned by tests. */
export function pickWatchtowerCandidates(
  items: Array<{ id: string; from: string; subject: string; snippet?: string }>,
  signalFor: (key: string) => SenderSignal | undefined,
  alreadyPinged: Set<string>,
): WatchtowerCandidate[] {
  return items
    .filter((m) => m.id && !alreadyPinged.has(m.id))
    .filter((m) => !isNoiseMail(m))
    .map((m) => {
      const kind = classifyBriefMail(m)
      const { score, reasons } = scoreMail({ ...m, kind }, signalFor(senderKey(m.from)))
      return { id: m.id, from: m.from, subject: m.subject, snippet: m.snippet || '', kind, score, reasons }
    })
    .filter(
      (m) =>
        m.score >= WATCHTOWER_REGEX_BAR &&
        (m.kind === 'reply' ||
          m.kind === 'money' ||
          m.kind === 'assessment' ||
          // A delivery delay is low-risk and needs no decision from anyone:
          // surface it once, on its own, and never ask.
          m.kind === 'delivery' ||
          mailHasDeadline(m) ||
          isTravelConfirmation(m)),
    )
    .sort((a, b) => b.score - a.score)
}
