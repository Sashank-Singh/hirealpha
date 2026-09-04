import { mkdirSync, appendFileSync, readdirSync, readFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gmiChat } from './gmi'
import type { AgentId } from '../../src/agents/types'

/**
 * Lightweight turn evals for the hires: every outbound turn is appended to a
 * per-day JSONL under <dataDir>/evals with latency and shape, and a sample of
 * turns is scored by the model (intelligence, tone, brevity) so reply quality
 * degrades loudly instead of silently. Scoring never blocks the reply.
 */

export type TurnRecord = {
  ts: string
  persona: AgentId
  /** Phone hashed so the log is not a contact list. */
  sender: string
  userText: string
  reply: string
  card: boolean
  texts: number
  source: 'gmi' | 'local'
  totalMs: number
  score?: TurnScore
}

export type TurnScore = {
  intelligence: number
  tone: number
  brevity: number
  human: number
  wouldReply: boolean
  why: string
}

export function hashPhone(phone: string): string {
  let h = 0
  for (let i = 0; i < phone.length; i++) h = (Math.imul(31, h) + phone.charCodeAt(i)) | 0
  return `u${(h >>> 0).toString(36)}`
}

function evalsDir(dataDir: string): string {
  return join(dataDir, 'evals')
}

function dayFile(dataDir: string, d = new Date()): string {
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return join(evalsDir(dataDir), `${ymd}.jsonl`)
}

export function logTurn(dataDir: string, record: TurnRecord): void {
  try {
    const dir = evalsDir(dataDir)
    mkdirSync(dir, { recursive: true })
    appendFileSync(dayFile(dataDir), JSON.stringify(record) + '\n')
  } catch (err) {
    console.warn('[evals] log failed', err)
  }
}

/** Judge a turn with the model. Pure; returns null on any failure so the
 * reply path is never hurt by scoring. */
export async function scoreTurn(input: {
  persona: AgentId
  userText: string
  reply: string
}): Promise<TurnScore | null> {
  try {
    const raw = await gmiChat({
      temperature: 0,
      maxTokens: 160,
      messages: [
        {
          role: 'system',
          content:
            'You judge one assistant text exchange. Rate the assistant reply on four 0-100 scales: intelligence (useful, specific, not generic), tone (warm, human, matches a close contact), brevity (short like a text, no fluff), human (reads like a person, not a bot). Also say whether the person would plausibly keep replying. Reply JSON only: {"intelligence":0,"tone":0,"brevity":0,"human":0,"wouldReply":true,"why":"one short clause"}',
        },
        {
          role: 'user',
          content: `Person: ${input.persona}\nThem: ${input.userText.slice(0, 300)}\nAssistant: ${input.reply.slice(0, 500)}`,
        },
      ],
    })
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0]) as Partial<TurnScore>
    const clamp = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : d)
    return {
      intelligence: clamp(j.intelligence, 50),
      tone: clamp(j.tone, 50),
      brevity: clamp(j.brevity, 50),
      human: clamp(j.human, 50),
      wouldReply: j.wouldReply !== false,
      why: String(j.why || '').slice(0, 140),
    }
  } catch {
    return null
  }
}

/** Score the last N turns of a day, in place, updating the JSONL rows. */
export async function backfillScores(dataDir: string, limit = 5): Promise<number> {
  const file = dayFile(dataDir)
  if (!existsSync(file)) return 0
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const tail = lines.slice(-limit)
    let scored = 0
    const out: string[] = []
    for (const line of tail) {
      let rec: TurnRecord
      try {
        rec = JSON.parse(line) as TurnRecord
      } catch {
        continue
      }
      if (rec.score) {
        out.push(line)
        continue
      }
      const score = await scoreTurn({ persona: rec.persona, userText: rec.userText, reply: rec.reply })
      if (score) {
        rec.score = score
        scored++
      }
      out.push(JSON.stringify(rec))
    }
    const prefix = lines.slice(0, lines.length - tail.length)
    const tmp = join(evalsDir(dataDir), `.tmp-${Date.now()}`)
    writeFileSync(tmp, [...prefix, ...out].join('\n') + '\n')
    rmSync(file, { force: true })
    renameSync(tmp, file)
    return scored
  } catch (err) {
    console.warn('[evals] backfill failed', err)
    return 0
  }
}

/** Read today's rows (optionally only scored ones) for the health surface. */
export function readTurns(dataDir: string, opts?: { scored?: boolean; limit?: number }): TurnRecord[] {
  const file = dayFile(dataDir)
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const rows: TurnRecord[] = []
    for (const line of lines.slice(-(opts?.limit ?? 50))) {
      try {
        const r = JSON.parse(line) as TurnRecord
        if (opts?.scored && !r.score) continue
        rows.push(r)
      } catch {
        /* skip */
      }
    }
    return rows
  } catch {
    return []
  }
}

export function dayFiles(dataDir: string): string[] {
  const dir = evalsDir(dataDir)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    return []
  }
}
