import type { SQL } from 'bun'
import { nutritionModelConfig } from '../habits/parsers'
import { withTimeout } from '../utils/async'
import { modelReplyText, stripReasoning } from '../modelJson'
import {
  MAIL_JUDGE_SYSTEM,
  mailJudgePrompt,
  parseMailJudgeVerdicts,
  type MailJudgeItem,
  type MailJudgeVerdict,
} from '../gmailHelpers'
import { localDateStrInTz } from '../timezones'
import {
  JUDGE_ALL_SYSTEM,
  judgeAllPrompt,
  parseJudgeAll,
  JUDGE_MAIL_CAP,
  JUDGE_MEET_CAP,
  judgeRowFresh,
  judgeRowCovers,
  type JudgeMailIn,
  type JudgeMeetIn,
  type MailVerdict,
  type MeetVerdict,
  type JudgeAll,
} from '../aiJudge'

/**
 * Morning/evening-brief payload: calendar (direct Google, no error strings),
 * important + medium mail, reminders. `brief` tells the frontend which variant.
 * Calendar uses fetchCalendarItems directly so "Calendar is not connected" error
 * strings never leak into the event list.
 */
export async function gmiBriefChat(
  system: string,
  user: string,
  maxTokens = 180,
  timeoutMs = 5000,
  opts: { plainText?: boolean } = {},
): Promise<string | null> {
  const cfg = nutritionModelConfig()
  if (!cfg) return null
  try {
    const raw = await withTimeout(
      (async () => {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
            'User-Agent': 'HireAlpha/0.1 (brief-mail)',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model: cfg.textModel,
            temperature: 0.1,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        })
        if (!res.ok) return ''
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
        }
        const msg = data.choices?.[0]?.message
        // A visible reply must be the model's content, never its scratchpad. The
        // reasoning fallback exists for JSON extraction (judge), where a reasoning
        // model can put the answer in reasoning_content; a rewrite body is not that.
        if (opts.plainText) return stripReasoning(String(msg?.content ?? ''))
        return modelReplyText(msg)
      })(),
      timeoutMs,
      '',
    )
    return raw || null
  } catch {
    return null
  }
}

/**
 * One model pass over an inbox batch, answering keep-or-drop and a pile name per
 * mail. Returns a verdict per item the model reached; callers decide what to do
 * with the rest. Empty map on failure, so every caller degrades on its own terms.
 *
 * Batch cap 20 with room for a line each — the old 180 tokens only had to carry
 * a list of numbers.
 */
export async function judgeMailBatch(
  items: Array<{ id: string; from: string; subject: string; snippet?: string }>,
  vocab: string[] = [],
  opts: { limit?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<Map<string, MailJudgeVerdict>> {
  if (!items.length) return new Map()
  const batch: MailJudgeItem[] = items.slice(0, opts.limit ?? 20).map((m) => ({
    id: m.id,
    from: m.from,
    subject: m.subject,
    snippet: m.snippet || '',
  }))
  const raw = await gmiBriefChat(
    MAIL_JUDGE_SYSTEM,
    mailJudgePrompt(batch, vocab),
    opts.maxTokens ?? 700,
    opts.timeoutMs ?? 8000,
  )
  if (!raw) return new Map()
  return new Map(parseMailJudgeVerdicts(raw, batch).map((v) => [v.id, v]))
}

/** Model judges a recent inbox batch. On failure the head survives un-bucketed, so the brief never loses mail. */
export async function judgeBriefMail<T extends { id: string; from: string; subject: string; snippet?: string }>(
  items: T[],
  limit = 5,
  vocab: string[] = [],
): Promise<Array<T & { kind: string }>> {
  const verdicts = await judgeMailBatch(items, vocab)
  // No verdicts must never blank the brief's mail: hand back the head of the
  // batch un-bucketed so the caller's groupMailByKind falls back to the regex
  // classifier per item. A judge failure costs the reasons, not the mail.
  if (!verdicts.size) return items.slice(0, limit).map((m) => ({ ...m, kind: '' }))
  return items
    .filter((m) => verdicts.get(m.id)?.keep)
    .slice(0, limit)
    .map((m) => ({ ...m, kind: verdicts.get(m.id)?.kind || '' }))
}

/* ---- One model call, one cache row ----
 * The judgment layer used to be regexes layered on the judge's pile names.
 * Now the same single call that names the piles also decides needs-you, urgency
 * scores, and meeting prep, and the verdicts persist in hire_judge_cache for
 * fifteen minutes. An open of any brief inside that window is cache-only: zero
 * model calls, whatever the request path. */

export type JudgeCachePayload = {
  mails: MailVerdict[]
  meets: MeetVerdict[]
  mailIds: string[]
}

/** One model pass over the whole batch. Empty maps on failure, so callers keep
 * their regex fallback. */
export async function judgeAllBatch(
  mails: JudgeMailIn[],
  meets: JudgeMeetIn[],
  vocab: string[],
): Promise<JudgeAll> {
  if (!mails.length && !meets.length) return { mails: new Map(), meets: new Map() }
  const raw = await gmiBriefChat(
    JUDGE_ALL_SYSTEM,
    judgeAllPrompt(mails.slice(0, JUDGE_MAIL_CAP), meets.slice(0, JUDGE_MEET_CAP), vocab),
    1500,
    12000,
  )
  if (!raw) return { mails: new Map(), meets: new Map() }
  return parseJudgeAll(raw, mails.slice(0, JUDGE_MAIL_CAP), meets.slice(0, JUDGE_MEET_CAP))
}

export async function readJudgeRow(
  sql: SQL,
  userId: string,
): Promise<{ payload: JudgeCachePayload; builtAt: number; day: string } | null> {
  try {
    const rows = (await sql`
      SELECT payload, built_at AS "builtAt", day FROM hire_judge_cache WHERE user_id = ${userId} LIMIT 1
    `) as Array<{ payload: JudgeCachePayload; builtAt: Date; day: string }>
    const row = rows[0]
    if (!row) return null
    return { payload: row.payload, builtAt: new Date(row.builtAt).getTime(), day: row.day }
  } catch {
    return null
  }
}

export async function writeJudgeRow(
  sql: SQL,
  userId: string,
  day: string,
  payload: JudgeCachePayload,
): Promise<void> {
  try {
    await sql`
      INSERT INTO hire_judge_cache (user_id, payload, day, built_at)
      VALUES (${userId}, ${JSON.stringify(payload)}, ${day}, now())
      ON CONFLICT (user_id) DO UPDATE SET payload = excluded.payload, day = excluded.day, built_at = excluded.built_at
    `
  } catch {
    /* A cache write must never take a read down with it. */
  }
}

/** Kinds this user's mail keeps producing, most used first. Offered to the judge. */
export async function loadMailKindVocab(sql: SQL, userId: string, limit = 12): Promise<string[]> {
  try {
    const rows = await sql`
      SELECT kind FROM hire_mail_kinds
      WHERE user_id = ${userId}
      ORDER BY uses DESC, last_used_at DESC
      LIMIT ${limit}
    `
    return (rows as { kind: string }[]).map((r) => r.kind).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Record the kinds a run actually used, then drop the ones that never caught on.
 * A label seen once or twice and not since is a model one-off, not vocabulary —
 * leaving it in would keep offering it back and make the set grow forever.
 */
export async function saveMailKindVocab(
  sql: SQL,
  userId: string,
  groups: Array<{ kind: string; label: string; count: number }>,
): Promise<void> {
  const rows = groups.filter((g) => g.kind && g.kind !== 'other' && g.count > 0)
  if (!rows.length) return
  try {
    for (const g of rows) {
      await sql`
        INSERT INTO hire_mail_kinds (user_id, kind, label, uses, last_used_at)
        VALUES (${userId}, ${g.kind}, ${g.label}, ${g.count}, now())
        ON CONFLICT (user_id, kind) DO UPDATE
          SET uses = hire_mail_kinds.uses + ${g.count},
              label = EXCLUDED.label,
              last_used_at = now()
      `
    }
    await sql`
      DELETE FROM hire_mail_kinds
      WHERE user_id = ${userId} AND uses < 3 AND last_used_at < now() - interval '60 days'
    `
  } catch (err) {
    // Vocabulary is an optimisation. A write failure must not cost the brief.
    console.warn('[mail-kinds] save failed', err)
  }
}

/**
 * Verdicts for the caller's mail and meetings, from the cache when it is fresh
 * and still covers most of the batch, otherwise from exactly one model call
 * that lands back in the cache. Null means the model answered nothing — the
 * caller falls back to the regex layers rather than showing an unjudged brief.
 */
export async function loadJudgeVerdicts(
  sql: SQL,
  userId: string,
  mails: JudgeMailIn[],
  meets: JudgeMeetIn[],
  tz?: string | null,
  vocab?: string[],
): Promise<JudgeAll | null> {
  const today = localDateStrInTz(new Date(), tz)
  const row = await readJudgeRow(sql, userId)
  if (
    row &&
    judgeRowFresh(row.builtAt, Date.now(), row.day, today) &&
    judgeRowCovers(row.payload.mailIds, mails.map((m) => m.id))
  ) {
    return {
      mails: new Map(row.payload.mails.map((m) => [m.id, m])),
      meets: new Map(row.payload.meets.map((m) => [m.id, m])),
    }
  }
  const verdicts = await judgeAllBatch(mails, meets, vocab ?? (await loadMailKindVocab(sql, userId)))
  if (!verdicts.mails.size && !verdicts.meets.size) {
    /* The model did not answer. A same-day row that is merely past its TTL is
     * still far better than no ranking at all — and returning null threw away
     * a usable cache and silently dropped Needs You ordering, scores, prep
     * flags and reasons for the whole brief. Serve the stale row when it is
     * from today; only a total miss returns null. */
    if (row && row.day === today) {
      console.warn('[judge] model did not answer; serving the same-day cache row')
      return {
        mails: new Map(row.payload.mails.map((m) => [m.id, m])),
        meets: new Map(row.payload.meets.map((m) => [m.id, m])),
      }
    }
    return null
  }
  await writeJudgeRow(sql, userId, today, {
    mails: [...verdicts.mails.values()],
    meets: [...verdicts.meets.values()],
    mailIds: mails.slice(0, JUDGE_MAIL_CAP).map((m) => m.id),
  })
  return verdicts
}

/** The attention slot, now judged by the model: the highest-urgency needs-you
 * mail with its own reason line. Null hands the slot back to the regex pick. */
export function judgedAttentionPick(
  verdicts: JudgeAll,
  lines: Map<string, { label: string; snippet?: string }>,
): { id: string; label: string; snippet?: string; why: string } | null {
  const scored = [...verdicts.mails.values()]
    .filter((v) => (v.needsYou || v.score >= 70) && v.keep && lines.has(v.id))
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best) return null
  const line = lines.get(best.id)!
  return { id: best.id, label: line.label, snippet: line.snippet, why: best.why || 'needs you' }
}

/** Stable id for a today-meeting: clock time plus the displayed title, the two
 * fields both the judge input and the digest row carry. */
export function meetJudgeKey(m: { time: string; title: string; who?: string }): string {
  return `${m.time}|${m.who || m.title}`
}

/* ---- Persisted brief cache ----
 * The in-memory stale caches above live and die with the container. A brief is
 * still useful the moment a tap lands after a deploy, so the last successful
 * build of the day is kept in Postgres as a one-minute stand-in — anything the
 * client holds is a paint that must not be *served* as if it were current. */
/* The whole point of the client keeping a 4-hour copy is a fast paint; the
 * server must never serve that copy as current. Mail only stays true for
 * minutes, so a persisted row is trusted for a single minute and every later
 * open rebuilds (calendar + Gmail + model) behind the client's already-painted
 * screen — the retry ladder swaps in the fresh mail a couple of seconds later
 * instead of showing you three-hour-old mail as today's. The in-memory cache
 * above already makes repeat opens within four minutes free. */
export const BRIEF_STALE_MS = 60_000

/** A persisted row is still worth a fast serve when it was built today and recently. */
export function briefRowFresh(rowAgeMs: number | null, today: string, rowDay: string | null): boolean {
  if (!rowAgeMs || rowDay !== today) return false
  return rowAgeMs < BRIEF_STALE_MS
}

/** A persisted row is at least for *today* (cross-day is always a miss). The
 * rationing path that serves stale rows on purpose MUST still gate on this: a
 * brief stamped for yesterday, served "stale on purpose" because the user is
 * over the free-tier build cap, is the bug that reports the brief as stuck on
 * a date two days ago. Cross-day → refuse, and let the caller's loader rebuild
 * (or surface the build failure) instead of painting yesterday's brief as
 * today's. */
export function briefRowSameDay(rowDay: string | null, today: string): boolean {
  return !!rowDay && rowDay === today
}

export async function readBriefDb(
  sql: SQL,
  userId: string,
  persona: string,
  kind: string,
): Promise<{ payload: Record<string, unknown>; day: string; builtAt: Date } | null> {
  try {
    const rows = (await sql`
      SELECT day, payload, built_at AS "builtAt" FROM hire_brief_cache
      WHERE user_id = ${userId} AND persona = ${persona} AND kind = ${kind}
      LIMIT 1
    `) as Array<{ day: string; payload: string; builtAt: Date }>
    const row = rows[0]
    if (!row) return null
    const payload = JSON.parse(row.payload)
    if (payload && Array.isArray(payload.dayFacts)) {
      payload.dayFacts = payload.dayFacts.filter(
        (f: Record<string, unknown> | null | undefined) =>
          f?.key !== 'gratitude' &&
          !/gratitude/i.test(String(f?.label || '')) &&
          !/gratitude/i.test(String(f?.key || '')),
      )
    }
    return { payload: payload as Record<string, unknown>, day: row.day, builtAt: row.builtAt }
  } catch {
    return null
  }
}

export async function writeBriefDb(
  sql: SQL,
  userId: string,
  persona: string,
  kind: string,
  day: string,
  payload: unknown,
): Promise<void> {
  try {
    await sql`
      INSERT INTO hire_brief_cache (user_id, persona, kind, day, payload, built_at)
      VALUES (${userId}, ${persona}, ${kind}, ${day}, ${JSON.stringify(payload)}, now())
      ON CONFLICT (user_id, persona, kind)
      DO UPDATE SET day = excluded.day, payload = excluded.payload, built_at = excluded.built_at
    `
  } catch {
    /* A cache row must never take a read down with it. */
  }
}
