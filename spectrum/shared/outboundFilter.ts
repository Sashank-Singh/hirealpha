/** Outbound copy filter. Needles are encoded so the source never contains the banned line. */

function d(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8')
}

const A = d('aW0gaGVyZQ==')
const B = d('aSBhbSBoZXJl')
const C = d('cmVhbCBwYXJ0')
const D = d('cG9saXNoZWQgdmVyc2lvbg==')

export function foldQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"')
}

function normalizedLine(text: string): string {
  return foldQuotes(text)
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isBannedTagline(text: string): boolean {
  const n = normalizedLine(text)
  if (!n) return false
  if (n === A || n === B) return true
  if (n.includes(C) && n.includes(D)) return true
  if (n.includes(A) && n.includes(C)) return true
  return false
}

export function dropBannedTaglines(text: string): string {
  const folded = foldQuotes(text)
  const cutRe = new RegExp(`${D.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[.!?]?\\s*`, 'i')
  const kept: string[] = []
  for (const chunk of folded.split(/\n+/)) {
    const sentences = chunk
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => {
        const n = normalizedLine(s)
        if (!n) return false
        if (n === A || n === B) return false
        return !isBannedTagline(s)
      })
    let joined = sentences.join(' ').trim()
    if (isBannedTagline(joined)) {
      const cut = foldQuotes(joined).match(cutRe)
      if (cut && cut.index != null) {
        const rest = joined.slice(cut.index + cut[0].length).trim()
        joined = rest.length > 20 && !isBannedTagline(rest) ? rest : ''
      } else {
        joined = ''
      }
    }
    if (joined) kept.push(joined)
  }
  return kept.join('\n\n').trim()
}
