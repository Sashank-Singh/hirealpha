export function stripNudgeDashes(text: string): string {
  return text.replace(/[\u2013\u2014]/g, ',').replace(/\s+-\s+/g, '. ').trim()
}

export function meetingWho(title: string): string {
  const withM = title.match(/\bwith\s+([^,:(/]+)/i)
  if (withM?.[1]) return withM[1].trim().split(/\s+/).slice(0, 2).join(' ')
  const cleaned = title
    .replace(/\b(1\s*:\s*1|1-1|sync|meeting|call|zoom|standup|interview)\b/gi, ' ')
    .replace(/[/|·,]+/g, ' ')
    .trim()
  const parts = cleaned.split(/\s+/).filter(Boolean)
  return (parts[0] || title).slice(0, 40)
}

export function loopNudgeText(title: string, weekday: string): string {
  const who = title.match(/\b(?:to|with|for)\s+([A-Za-z][A-Za-z'-]+)/)?.[1]
  if (who) return `You told ${who} you'd get back by ${weekday}. It's ${weekday}.`
  const clipped = title.replace(/\.$/, '').slice(0, 80)
  return `${clipped}. That was due ${weekday}. It's ${weekday}.`
}

export function decisionNudgeText(decision: string): string {
  const clipped = decision.replace(/\.$/, '').slice(0, 80)
  const labeled = /^(the|a|an)\s/i.test(clipped) ? clipped : `the ${clipped}`
  return `Decision review date hit. How did ${labeled} turn out?`
}

export function meetingNudgeText(title: string, mins: number): string {
  const who = meetingWho(title)
  const wait = Math.max(1, mins)
  const unit = wait === 1 ? 'min' : 'mins'
  return `Meeting with ${who} in ${wait} ${unit}. Do you want to prep?`
}

export function slugNudge(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 48) || 'x'
}

export function slackMentionText(m: { channel: string; text: string }): string {
  const ch = m.channel ? ` in #${m.channel}` : ''
  const body = m.text.replace(/<@[^>]+>/g, '').replace(/\s+/g, ' ').trim() || 'You were mentioned.'
  return `Slack mention${ch}: ${body}`.slice(0, 300)
}

export function linearAssignedText(i: { identifier: string; title: string }): string {
  const title = i.title.replace(/\s+/g, ' ').trim()
  // The walker falls back to a truncated-title identifier when Linear gives
  // no key; prefix-matched identifiers add noise, drop them.
  const id = i.identifier && !title.startsWith(i.identifier) ? `${i.identifier} ` : ''
  return `Linear: ${id}${title}`.slice(0, 240)
}
