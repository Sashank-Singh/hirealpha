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
export function handleBrainDump(text: string, timezone: string): string {
  void timezone
  const body = text
    .replace(/^dump\b|^brain dump\b|^here's the deal\b|^heres the deal\b/i, '')
    .replace(/^[:\s-]+/, '')
    .trim()
  const loops: string[] = []
  const reminders: string[] = []
  const decisions: string[] = []
  const sentences = body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim().replace(/^[-•]\s*/, '')).filter(Boolean)
  for (const s of sentences) {
    if (/\b(?:decid\w*|going with|chose|pick(?:ed)?)\b/i.test(s)) decisions.push(s)
    else if (/\b(?:need to|have to|must|should|remember to|call|email|text|buy|schedule|send|follow up)\b/i.test(s)) loops.push(s)
    else reminders.push(s)
  }
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

/** 6. Billguard: count subscriptions from mail scan results. */
export function handleBillguard(subscriptions: Array<{ name: string; amount?: string; next?: string }>): string {
  if (!subscriptions.length) return 'No recurring charges found in your recent mail.'
  const lines = subscriptions.map((s) => `- ${s.name}${s.amount ? ` · ${s.amount}` : ''}${s.next ? ` · next ${s.next}` : ''}`)
  return `Subscriptions on file:\n${lines.join('\n')}\nI will flag renewals and price changes in the brief.`
}

/** 7. Travel Mode: an honest hint in a single turn; full timezone shift lives
 * in the brief/reminder layer, owning its own toggles (TRAVEL_MODE). */
export function handleTravelMode(dest: string): string {
  return `Travel mode on for ${dest || 'your trip'}. I will shift brief times, hold pings, and build a checklist before you go. (Full timezone-aware scheduling is a follow-up.)`
}

/** 8. Keep Me Honest: convert "keep me honest at 7pm to run" into a reminder. */
export function handleKeepMeHonest(text: string, timezone: string): string {
  const at = text.match(/\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  const what = text.replace(/\bkeep\s+me\s+honest\b/i, '').replace(/\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i, '').trim()
  if (!at || !what) return 'Say like: "keep me honest at 7pm to run" — I will remind you only if it hasn\'t happened.'
  let h = Number(at[1]); const m = Number(at[2] || '0'); const ap = (at[3] || '').toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return `Kept honest: ${what} at ${h}:${String(m).padStart(2, '0')} ${ap || ''}`.trim() + ` (${timezone}) — conditional on state, in the brief.`
}

/** 9. Toolbox: the user's kept builds as a gallery list. */
export function handleToolbox(builds: Array<{ title: string; url: string }>): string {
  if (!builds.length) return 'No keeps yet. Build something and say keep it and it lives here.'
  return `Your toolbox:\n${builds.map((b, i) => `${i + 1}. ${b.title} — ${b.url}`).join('\n')}`
}