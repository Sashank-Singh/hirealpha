/**
 * Smart features: Recall, Debrief, Sweep, Brain Dump, Snap Log, Billguard,
 * Travel Mode, Keep Me Honest, Toolbox gallery.
 *
 * All are text-first: they hook into a chat turn before mini-app routing, so
 * "recall what I promised maya", "debrief the call", "sweep", "dump: …",
 * "keep me honest at 7pm to run", "how much do i pay for netflix", "snap log
 * <photo>", "travel mode to tokyo" each return a local, deterministic answer.
 * Everything reads existing stores — no new tables, no new infra.
 */

export type SmartFeatureResult =
  | { kind: 'recall' }
  | { kind: 'debrief' }
  | { kind: 'sweep' }
  | { kind: 'brain_dump' }
  | { kind: 'snap_log' }
  | { kind: 'billguard' }
  | { kind: 'travel_mode' }
  | { kind: 'keep_me_honest' }
  | { kind: 'toolbox' }

/* ---- Intent detectors ---- */

export function looksLikeRecall(text: string): boolean {
  return /\b(?:what|who|when|where|why|how|did|does|is|are|was|have i|have we|recall|find|search|remind me what|do you know)\b/i.test(text) &&
    /\b(?:promise|promised|loop|owe|owed|decide|decision|meet|meeting|said|talk(?:ed)?|mail|email|note|notes|asked|agreed)\b/i.test(text)
}

export function looksLikeDebrief(text: string): boolean {
  return /\b(?:debrief|how did (?:the |that )?(?:meeting|call|interview|sync)|wrap (?:the )?(?:meeting|call|day)|after (?:the )?(?:meeting|call))\b/i.test(text)
}

export function looksLikeSweep(text: string): boolean {
  return /\bsweep\b|(?:draft|write|prep).{0,20}\b(?:all|every|replies?|responses?)\b/i.test(text) || /\b(?:inbox) zero\b/i.test(text)
}

export function looksLikeBrainDump(text: string): boolean {
  return /^dump\b|\bbrain dump\b|^(?:here's|heres|here is)\s+the\s+(?:deal|situation|day)\b/i.test(text)
}

export function looksLikeSnapLog(text: string): boolean {
  return /\bsnap\s*(?:log|post)?\b|\bphoto\s*(?:log|of)?\b|\btrack (?:this|that)\s*(?:by)?\s*photo\b/i.test(text)
}

export function looksLikeBillguard(text: string): boolean {
  return /\b(?:how much|what)\s+do\s+i\s+pay\b|\b(?:subscriptions?|recurring|bills?|cancel)\b/i.test(text)
}

export function looksLikeTravelMode(text: string): boolean {
  return /\btravel\s*mode\b|\bto\s+(?:tokyo|paris|london|bali|nyc|new york|sf|san francisco|the\s*)?(?:next|this|in|on)\s*(?:week|month|trip)\b|\b(?:flying|traveling|travelling|going)\s+to\s/i.test(text)
}

export function looksLikeKeepMeHonest(text: string): boolean {
  return /\bkeep\s+me\s+honest\b|\btext\s+me\s+(?:at|when|if)\b|\bnag\s+me\b|\bif\s+i\s+haven.?t\b/i.test(text)
}

export function looksLikeToolbox(text: string): boolean {
  return /\b(?:my\s+)?tools?\b|\b(?:my\s+)?builds?\b|\b(?:app|apps)\s*(?:gallery|shelf|i\s+built)\b|\bshow\s+(?:me\s+)?(?:my\s+)?(?:tools|builds|apps)\b/i.test(text)
}

/** B3. "import maya's chat", "paste the whatsapp export", "sync my iMessage
 * thread with Maya", or literally a pasted block of "Name: message" lines. */
export function looksLikeChatImport(text: string): boolean {
  return /^\s*\/import\b/i.test(text) ||
    /\b(?:import|ingest|load|sync|read)\b.{0,25}\b(?:chat|thread|export|conversation|whatsapp|imessage|messages|transcript)\b/i.test(text) ||
    /^\s*(?:\[[^\]]*\])?\s*[A-Z][A-Za-z .'-]{1,30}\s*[:：]\s*.+(\n\s*(?:\[[^\]]*\])?\s*[A-Z][A-Za-z .'-]{1,30}\s*[:：]\s*.+){2,}/i.test(text)
}

/** The human-facing ack; the real per-person write happens in the turn. */
export function handleChatImport(): string {
  return 'On it — importing that conversation and filing each person\'s lines as context for prep and recall.'
}

/* ---- Structured parsers (pure; drive both the reply text and real persistence) ---- */

export type BrainDumpItems = { loops: string[]; decisions: string[]; notes: string[] }

/** Turn a free-text brain dump into loops, decisions, and timed-able notes.
 * Pure and deterministic: the same parse drives `handleBrainDump`'s display text
 * and the true writes the turn performs afterwards. */
export function parseBrainDump(text: string): BrainDumpItems {
  const body = text
    .replace(/^dump\b|^brain dump\b|^here's the deal\b|^heres the deal\b/i, '')
    .replace(/^[:：\s-]+/, '')
    .trim()
  const loops: string[] = []
  const notes: string[] = []
  const decisions: string[] = []
  const sentences = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().replace(/^[-•]\s*/, ''))
    .filter(Boolean)
  for (const s of sentences) {
    if (/\b(?:decid\w*|going with|chose|pick(?:ed)?)\b/i.test(s)) decisions.push(s)
    else if (/\b(?:need to|have to|must|should|remember to|call|email|text|buy|schedule|send|follow up)\b/i.test(s)) loops.push(s)
    else notes.push(s)
  }
  return { loops, decisions, notes }
}

export type KeepHonestPlan = { what: string; hour: number; minute: number }

/** "keep me honest at 7pm to run" → { what: "run", hour: 19, minute: 0 }. Null when
 * the intent is incomplete. Shared by the reply text and the real reminder write. */
export function keepHonestPlan(text: string): KeepHonestPlan | null {
  const at = text.match(/\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  const what = text
    .replace(/\bkeep\s+me\s+honest\b/i, '')
    .replace(/\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i, '')
    .trim()
  if (!at || !what) return null
  let h = Number(at[1]); const m = Number(at[2] || '0'); const ap = (at[3] || '').toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return { what, hour: h, minute: m }
}

/* ---- B3. Chat export → per-person context -------------------------------- */

export type ChatPerson = { name: string; lines: string[] }

/** A tolerant parser for pasted chat exports (iMessage, WhatsApp, or bare
 * "Name: text" lines). Drops the user's own side ("you"/"me") and the import
 * header, so the rest becomes per-person context for prep and recall. */
export function parseChatExport(text: string): ChatPerson[] {
  const self = /^(?:you|me|i)\b/i
  const byName = new Map<string, string[]>()
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    // [2026-08-01 14:03] Maya: message
    let m = line.match(/^\s*\[[^\]]*\]\s*(.+?)\s*[:：]\s*(.+)$/)
    // 8/1/26, 2:03 PM - Maya Chen: message
    if (!m) m = line.match(/^\s*\d{1,2}\/\d{1,2}\/\d{2,4},\s*[\d:, APMapm]+\s*-\s*(.+?)\s*[:：]\s*(.+)$/)
    // Name: message
    if (!m) m = line.match(/^\s*(.+?)\s*[:：]\s*(.+)$/)
    if (!m) continue
    const name = m[1].trim().replace(/\s*:[^:]*$/, '').trim()
    const msg = m[2].trim()
    if (!name || !msg || self.test(name)) continue
    byName.set(name, [...(byName.get(name) || []), msg])
  }
  const people: ChatPerson[] = []
  for (const [name, lines] of byName) if (lines.length) people.push({ name, lines })
  return people.sort((a, b) => b.lines.length - a.lines.length)
}

/* ---- A7. Billguard renewal radar ----------------------------------------- */

export type SubscriptionHit = {
  merchant: string
  amount?: number
  period: string
  date?: string
}

/** Scan mail text for recurring charges and renewal dates. Returns structured
 * hits the turn can warn on ("Netflix renews 8/30", "Spotify went up"). */
export function scanSubscriptions(text: string): SubscriptionHit[] {
  const hits: SubscriptionHit[] = []
  const RE_VALUE = /(?:US)?\$?\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:\/|\s+per\s+|\s+a\s+)?(mo|month|yr|year|week|wk|quarter)/i
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    const value = l.match(RE_VALUE)
    if (!value) continue
    const merchant =
      l.match(/^(.*?)[:,—-]?\s*(?:renew|charg|billed?|due|next)/i)?.[1]?.trim() ||
      l.match(/^(.*?)[:,—-]?\s*\d/i)?.[1]?.trim() ||
      ''
    const date = l.match(/\b(?:renew(?:s|ing)?|billed?|due|next\s+charge)\s*(?:on|:)?\s*([0-9]{1,2}\/[0-9]{1,2}(?:\/[0-9]{2,4})?|\w+\s+\d{1,2})/i)?.[1]
    hits.push({
      merchant: merchant.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Subscription',
      amount: Number(value[1].replace(',', '.')),
      period: (value[2] || 'month').toLowerCase(),
      date,
    })
  }
  return hits
}

/* ---- A9. Travel real shift ------------------------------------------------ */

export type TravelPlan = { dest: string; tz?: string }

const TRAVEL_TZ: Record<string, string> = {
  tokyo: 'Asia/Tokyo', osaka: 'Asia/Tokyo', kyoto: 'Asia/Tokyo',
  paris: 'Europe/Paris', london: 'Europe/London', barcelona: 'Europe/Madrid',
  madrid: 'Europe/Madrid', rome: 'Europe/Rome', berlin: 'Europe/Berlin',
  amsterdam: 'Europe/Amsterdam', dubai: 'Asia/Dubai', singapore: 'Asia/Singapore',
  nyc: 'America/New_York', 'new york': 'America/New_York', 'san francisco': 'America/Los_Angeles', sf: 'America/Los_Angeles',
  la: 'America/Los_Angeles', 'los angeles': 'America/Los_Angeles', bali: 'Asia/Makassar',
  sydney: 'Australia/Sydney', 'mexico city': 'America/Mexico_City', bangkok: 'Asia/Bangkok',
  'hong kong': 'Asia/Hong_Kong', seoul: 'Asia/Seoul', honolulu: 'Pacific/Honolulu', maui: 'Pacific/Honolulu',
}

/** "travel mode to tokyo" / "flying to paris next week" → destination (+ tz if known). */
export function keepTravelPlan(text: string): TravelPlan | null {
  const m = text.match(/\b(?:to|for|in|at)\s+([A-Za-z][A-Za-z .'-]{1,30})/i)
  const dest = m?.[1]?.trim().toLowerCase().replace(/\s+(?:next|this|week|month|trip|on|in)\b.*$/i, '').trim()
  if (!dest) return null
  return { dest, tz: TRAVEL_TZ[dest] }
}

/* ---- A6. Debrief answers → real follow-ups -------------------------------- */

export type MeetingAnswerItems = { promises: string[]; decisions: string[]; followups: string[] }

/** Split the user's debrief answers ("I promised to send the deck by Friday",
 * "we decided on Stripe", "follow up with Maria") into persisted pieces. */
export function parseMeetingAnswer(text: string): MeetingAnswerItems {
  const promises: string[] = []
  const decisions: string[] = []
  const followups: string[] = []
  for (const s of String(text || '').split(/[.!?\n]+/).map((x) => x.trim()).filter(Boolean)) {
    if (/\b(?:i\s+(?:promis\w*|owe|need to|have to|must|will)|promis(?:e|ed)|owe|need to|have to|should|must)\b/i.test(s)) promises.push(s)
    else if (/\b(?:decid\w*|going with|chose|picked?|we went with)\b/i.test(s)) decisions.push(s)
    else if (/\b(?:follow.?up|circle back|reach out|get back|next step|action item)\b/i.test(s)) followups.push(s)
  }
  return { promises, decisions, followups }
}

/* ---- A3. Sweep batch approval --------------------------------------------- */

export type SweepDecision =
  | { action: 'send_all' }
  | { action: 'edit'; index: number }
  | { action: 'send'; indices: number[] }
  | { action: 'skip'; indices: number[] }

/** "1,3" / "send 1 and 3" → send those; "edit 2" → rework one; "send all"
 * / "1-send" → send every draft; "skip", "skip 2" → skip. Indexes are 1-based. */
export function parseSweepApproval(text: string, total: number): SweepDecision | null {
  const t = String(text || '').toLowerCase().trim()
  if (/^(?:send\s+)?all$|^1[- ]send$/i.test(t) || /^(?:send|approve|yes)\b/.test(t)) return { action: 'send_all' }
  if (/^skip\s+all$/.test(t) || /^skip$/.test(t)) return { action: 'skip', indices: [] }
  const edit = t.match(/\b(?:edit|rework|rewrite|change)\s*(?:#|draft)?\s*(\d+)/i)
  if (edit) {
    const i = Number(edit[1])
    if (i >= 1 && i <= total) return { action: 'edit', index: i }
  }
  const nums = t.match(/\d+/g)?.map(Number) || []
  const valid = [...new Set(nums.filter((n) => n >= 1 && n <= total))]
  if (valid.length) {
    const skip = /\bskip\b/.test(t)
    return { action: skip ? 'skip' : 'send', indices: valid }
  }
  return null
}

/* ---- Feature handlers (deterministic; wired into runHireTurn) ---- */

/** 1. Recall: what did I promise / decide / who did I meet? */
export function handleRecall(text: string, stores: { loops: string[]; decisions: string[]; meetings: string[] }): string {
  const arr = [...stores.loops, ...stores.decisions, ...stores.meetings].filter(Boolean)
  if (!arr.length) return 'Nothing on file yet. Log a promise, decision, or meeting and I can recall it later.'
  const keyword = text.replace(/\b(?:recall|search|find|what|who|when|where|why|how|did|does|is|are|was|have i|do you know|me|my|the|a|an|about|regarding|that|this)\b/gi, ' ').trim()
  const byKw = keyword ? arr.filter((l) => l.toLowerCase().includes(keyword.toLowerCase())) : []
  const pick = byKw.length ? byKw : arr
  return `Found ${pick.length}:\n${pick.slice(0, 5).map((l, i) => `${i + 1}. ${l}`).join('\n')}`
}

/** 2. Debrief: what did the meeting decide / what did you promise? */
export function handleDebrief(meetingTitle: string): string {
  const who = meetingTitle.replace(/\b(?:meeting|call|1-?1|sync|interview)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  return `Debrief ${meetingTitle || 'the call'}
- What went well?
- What did you promise? (say it and I will log it as a loop)
- What needs a follow-up?`
    .split('\n')
    .map((l) => (l.trim() ? l : ''))
    .join('\n')
}

/** 3. Sweep: count drafts pending approval. Real batching needs mail scans;
 * the turn surfaces the count and each pending draft. */
export function handleSweep(count: number, pending: string[]): string {
  if (!count) return 'Nothing waiting on you. Inbox zero.'
  return `Sweep: ${count} waiting on you.\n${pending.map((p, i) => `${i + 1}. ${p}`).join('\n')}\nReply with the numbers to approve (e.g. "1,3"), "edit #" to rework one, or "skip".`
}

/** 4. Brain Dump: turn a free-text dump into loops/reminders/decisions. */
export function handleBrainDump(text: string, timezone?: string): string {
  void timezone
  const { loops, decisions, notes } = parseBrainDump(text)
  const reminders = notes
  const out: string[] = []
  if (loops.length) out.push('Loops:\n' + loops.map((l) => `- ${l}`).join('\n'))
  if (decisions.length) out.push('Decisions:\n' + decisions.map((l) => `- ${l}`).join('\n'))
  if (reminders.length) out.push('Noted:\n' + reminders.map((l) => `- ${l}`).join('\n'))
  return out.length ? out.join('\n\n') : 'Nothing to file. Try "dump: call the dentist, email Maya the deck".'
}

/** 5. Snap Log: this turn can't see the photo bytes, so it asks for a photo. */
export function handleSnapLog(): string {
  return 'Send a photo of the meal, receipt, or board and I will log it.'
}

/** 6. Billguard: recurring charges + category sums from the user's real logs.
 * A keyword ("housing", "netflix") filters matching entries; no keyword gives
 * the weekly picture. */
export function handleBillguard(
  keyword: string,
  logs: Array<{ amount: number; category: string; description: string; spentAt?: string }>,
  weekly: number,
  budget: number,
): string {
  if (!logs.length) return 'No spending logged in the last 60 days. Log purchases in the Spending app and I will track every number.'
  const kw = keyword.toLowerCase().trim()
  const matches = kw
    ? logs.filter((l) =>
        `${l.category} ${l.description}`.toLowerCase().includes(kw) ||
        (kw.includes('hous') && /\b(?:rent|mortgage|housing)\b/i.test(`${l.category} ${l.description}`)),
      )
  : logs
  if (kw && matches.length) {
    const total = matches.reduce((sum, m) => sum + m.amount, 0)
    const lines = matches.slice(0, 6).map((m) => `- $${Math.round(m.amount * 100) / 100} · ${m.description || m.category}${m.spentAt ? ` · ${String(m.spentAt).slice(0, 10)}` : ''}`)
    return `${kw}: $${Math.round(total * 100) / 100} across ${matches.length} entr${matches.length === 1 ? 'y' : 'ies'} (last 60 days):\n${lines.join('\n')}`
  }
  if (kw) return `Nothing logged under "${kw}". If you log it in the Spending app, I will track it.`
  const top = logs.slice(0, 5).map((l) => `- $${Math.round(l.amount * 100) / 100} · ${l.description || l.category}`)
  const budgetLine = budget > 0 ? ` of $${budget} weekly budget` : ''
  return `This week: $${Math.round(weekly * 100) / 100}${budgetLine}. Recent:\n${top.join('\n')}`
}

/** 7. Travel Mode: an honest hint in a single turn; full timezone shift lives
 * in the brief/reminder layer, owning its own toggles (TRAVEL_MODE). */
export function handleTravelMode(dest: string): string {
  return `Travel mode on for ${dest || 'your trip'}. I will shift brief times, hold pings, and build a checklist before you go. (Full timezone-aware scheduling is a follow-up.)`
}

/** 8. Keep Me Honest: convert "keep me honest at 7pm to run" into a reminder. */
export function handleKeepMeHonest(text: string, timezone: string): string {
  const plan = keepHonestPlan(text)
  if (!plan) return 'Say like: "keep me honest at 7pm to run" — I will remind you only if it has not happened.'
  const ap = (text.match(/\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/i)?.[1] || '').toLowerCase()
  return `Kept honest: ${plan.what} at ${plan.hour}:${String(plan.minute).padStart(2, '0')} ${ap || ''}`.trim() + ` (${timezone})`
}

/** 9. Toolbox: the user's kept builds as a gallery list. */
export function handleToolbox(builds: Array<{ title: string; url: string }>): string {
  if (!builds.length) return 'No keeps yet. Build something and say keep it and it lives here.'
  return `Your toolbox:\n${builds.map((b, i) => `${i + 1}. ${b.title} — ${b.url}`).join('\n')}`
}