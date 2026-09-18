/**
 * Dump the message corpus as JSONL for improving the model.
 *
 *   bun run scripts/export-messages.ts                    # everything, to ./messages.jsonl
 *   bun run scripts/export-messages.ts --since 2026-09-01 --persona friend
 *   bun run scripts/export-messages.ts --phone +1216... --out /tmp/one-user.jsonl
 *   bun run scripts/export-messages.ts --chat                 # conversational pairs instead of rows
 *
 * Reads hire_message_log (see deploy/migrations/202609180001_message_log.sql).
 * Rows mode is one JSON object per text; `--chat` groups by turn so each line is
 * a user message and the reply it produced, which is the shape a fine-tune
 * wants. Nothing leaves this machine: the file is written locally.
 */
import { readFileSync, writeFileSync } from 'node:fs'

function envFrom(file: string): string | null {
  try {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      if (line.slice(0, eq).trim() === 'DATABASE_URL') return line.slice(eq + 1).trim()
    }
  } catch {
    /* file may not exist */
  }
  return null
}

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 ? args[i + 1] ?? '' : null
}
const chatMode = args.includes('--chat')
const out = flag('out') || (chatMode ? 'messages-chat.jsonl' : 'messages.jsonl')
const since = flag('since') || '1970-01-01'
const persona = flag('persona')
const phone = flag('phone')

const databaseUrl =
  process.env.DATABASE_URL ||
  envFrom('spectrum/alpha/.env') ||
  envFrom('spectrum/alpha/bench-runtime.env') ||
  envFrom('.env')
if (!databaseUrl) {
  console.error('No DATABASE_URL. Set it, or put it in spectrum/alpha/bench-runtime.env.')
  process.exit(1)
}

const { default: postgres } = await import('postgres')
const sql = postgres(databaseUrl, { max: 2, idle_timeout: 5, connect_timeout: 20 })

try {
  const rows = (await sql`
    SELECT phone, persona, role, text, source, turn_id, reply_ms, created_at
    FROM hire_message_log
    WHERE created_at >= ${since}::timestamptz
      AND (${persona}::text IS NULL OR persona = ${persona})
      AND (${phone}::text IS NULL OR phone = ${phone})
    ORDER BY created_at ASC
    LIMIT 200000
  `) as Array<{
    phone: string
    persona: string
    role: string
    text: string
    source: string | null
    turn_id: string | null
    reply_ms: number | null
    created_at: Date | string
  }>

  if (!chatMode) {
    const lines = rows.map((r) =>
      JSON.stringify({
        phone: r.phone,
        persona: r.persona,
        role: r.role,
        text: r.text,
        source: r.source,
        turnId: r.turn_id,
        replyMs: r.reply_ms,
        at: new Date(r.created_at).toISOString(),
      }),
    )
    writeFileSync(out, `${lines.join('\n')}\n`)
    console.log(`${lines.length} messages -> ${out}`)
  } else {
    // Group by turn: a user text plus the reply it produced, in order.
    const turns = new Map<string, { user?: string; alpha?: string; at: string; persona: string; source: string | null }>()
    for (const r of rows) {
      const key = r.turn_id || `${r.phone}|${new Date(r.created_at).toISOString()}`
      const entry = turns.get(key) || { at: new Date(r.created_at).toISOString(), persona: r.persona, source: null }
      if (r.role === 'user') entry.user = r.text
      else {
        entry.alpha = r.text
        entry.source = r.source
      }
      turns.set(key, entry)
    }
    const lines: string[] = []
    for (const t of turns.values()) {
      if (!t.user || !t.alpha) continue
      lines.push(JSON.stringify({ messages: [{ role: 'user', content: t.user }, { role: 'assistant', content: t.alpha }], persona: t.persona, source: t.source, at: t.at }))
    }
    writeFileSync(out, `${lines.join('\n')}\n`)
    console.log(`${lines.length} complete turns -> ${out}`)
  }
  console.log(`(${rows.length} rows read; filter with --since/--persona/--phone)`)
} finally {
  await sql.end({ timeout: 5 })
}
