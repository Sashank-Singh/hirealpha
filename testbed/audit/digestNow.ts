import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const OUT = join(import.meta.dir, 'out')
for (const f of readdirSync(OUT).filter((f) => f.endsWith('.json') && !f.startsWith('data_')).sort()) {
  const r = JSON.parse(readFileSync(join(OUT, f), 'utf8'))
  const lines: string[] = []
  lines.push(`### ${r.id} [${r.cat}] ${r.title} — llm=${r.llmCalls} ms=${r.wallMs}${r.error ? ' ERROR=' + r.error : ''}`)
  for (const t of r.turns) {
    lines.push(`  USER> ${t.text}`)
    for (const b of t.bubbles) lines.push(`  ALPHA> ${String(b).replace(/\s+/g, ' ').slice(0, 380)}`)
    const notable = (t.calls || []).filter((c: any) => !/touch|message-log|heartbeat|kill-switch|browser\/awaiting|browser\/last/.test(c.path))
    for (const c of notable) lines.push(`    CALL ${c.method} ${c.path.replace(/\?.*/, '')} ${JSON.stringify(c.body).replace(/\s+/g, ' ').slice(0, 240)}`)
    if (t.card) lines.push(`    CARD ${t.card}`)
  }
  const facts = (r.finalMemories || []).map((m: any) => `${m.key}=${String(m.value).slice(0, 50)}`).join('; ')
  if (facts) lines.push(`  SERVER-MEM> ${facts}`)
  console.log(lines.join('\n'))
}
