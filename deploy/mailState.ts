import type { SQL } from 'bun'
import { readGmailThreadExact } from './connectors/hub'

/**
 * Durable reply-state per Gmail thread ("waiting-on" state), so the natural
 * questions — "who owes me a reply?", "who am I ignoring?", "did Sam ever
 * reply?" — are answered from state that survives past any mailbox read
 * window, and are re-verified against the live thread before being stated.
 */

export type Awaiting = 'them' | 'me' | 'none'

export type ThreadStateRow = {
  threadId: string
  participant: string
  subject: string
  direction: 'inbound' | 'outbound'
  awaiting: Awaiting
  lastMessageId: string
  lastActivityAt: string
}

const AUTOMATED_FROM = /no-?reply|donotreply|mailer-daemon|notifications?@|newsletter|automated/i

/**
 * Who owes the next move, decided from the thread's newest message. The user's
 * own address sending last means the other side owes the reply; the
 * participant sending last means the user owes one; automated senders do not
 * move the state at all (an autoresponder must not flip a wait).
 */
export function classifyAwaiting(userEmail: string, participant: string, lastFrom: string, lastSubject?: string): Awaiting {
  const from = String(lastFrom || '').toLowerCase()
  if (!from) return 'none'
  // Vacation responders and bounces are machine mail even from a real
  // address: neither counts as "they replied".
  if (AUTOMATED_FROM.test(from)) return 'none'
  if (/\b(?:automatic reply|auto[-: ]?reply|out of office|delivery status notification|undeliver|mail delivery failed|returned mail)\b/i.test(String(lastSubject || ''))) return 'none'
  const mine = String(userEmail || '').toLowerCase()
  const fromAddress = from.match(/<([^>]+)>/)?.[1] || from
  if (mine && fromAddress.trim() === mine.trim()) return 'them'
  if (participant && fromAddress.includes(String(participant).toLowerCase())) return 'me'
  // A DIFFERENT human replied (not the expected participant). The user still
  // owes the next move, but callers must name who replied — "did Sam reply?"
  // must not read a Maya reply as a yes. refreshThreadState surfaces
  // lastFromMatchesParticipant for exactly that.
  return 'me'
}

/** Does the thread's newest message come from the expected participant? */
export function lastSenderIsParticipant(participant: string, lastFrom: string): boolean {
  const addr = (String(lastFrom || '').match(/<([^>]+)>/)?.[1] || String(lastFrom || '')).trim().toLowerCase()
  if (!addr) return false
  const want = String(participant || '').trim().toLowerCase()
  if (!want) return false
  return addr === want || addr.includes(want) || want.includes(addr)
}

/** Loose match of a spoken name ("Sam", "sam@x.com") against stored rows. */
export function pickThreadMatch(
  rows: ThreadStateRow[],
  q: string,
): ThreadStateRow | null {
  const needle = String(q || '').trim().toLowerCase()
  if (!needle) return null
  const byEmail = rows.find((r) => r.participant.toLowerCase() === needle)
  if (byEmail) return byEmail
  const nameHit = rows.filter((r) => r.participant.toLowerCase().includes(needle))
  if (nameHit.length === 1) return nameHit[0]!
  return null
}

export async function upsertThreadState(
  sql: SQL,
  userId: string,
  persona: string,
  row: { threadId: string; participant?: string; subject?: string; direction?: 'inbound' | 'outbound'; awaiting?: Awaiting; lastMessageId?: string },
): Promise<void> {
  if (!row.threadId) return
  await sql`
    INSERT INTO hire_thread_state (id, user_id, persona, thread_id, participant, subject, direction, awaiting, last_message_id, last_activity_at)
    VALUES (
      ${crypto.randomUUID()}, ${userId}, ${persona}, ${row.threadId},
      ${String(row.participant || '').slice(0, 200)}, ${String(row.subject || '').slice(0, 300)},
      ${row.direction || 'inbound'}, ${row.awaiting || 'none'}, ${String(row.lastMessageId || '').slice(0, 100)}, now()
    )
    ON CONFLICT (user_id, persona, thread_id) DO UPDATE SET
      participant = COALESCE(NULLIF(excluded.participant, ''), hire_thread_state.participant),
      subject = COALESCE(NULLIF(excluded.subject, ''), hire_thread_state.subject),
      direction = excluded.direction,
      awaiting = excluded.awaiting,
      last_message_id = COALESCE(NULLIF(excluded.last_message_id, ''), hire_thread_state.last_message_id),
      last_activity_at = now(),
      updated_at = now()
  `
}

async function rowsToState(rows: unknown[]): Promise<ThreadStateRow[]> {
  return rows.map((r) => {
    const row = r as {
      threadId: string; participant: string; subject: string; direction: string
      awaiting: Awaiting; lastMessageId: string; lastActivityAt: Date
    }
    return {
      threadId: row.threadId,
      participant: row.participant,
      subject: row.subject,
      direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
      awaiting: row.awaiting,
      lastMessageId: row.lastMessageId,
      lastActivityAt: row.lastActivityAt.toISOString(),
    }
  })
}

export async function listThreadState(
  sql: SQL, userId: string, persona: string, kind: 'waiting_on_them' | 'waiting_on_me' | 'all', limit = 25,
): Promise<ThreadStateRow[]> {
  const base = sql`
    SELECT thread_id AS "threadId", participant, subject, direction, awaiting,
      last_message_id AS "lastMessageId", last_activity_at AS "lastActivityAt"
    FROM hire_thread_state
    WHERE user_id = ${userId} AND persona = ${persona}
      ${kind === 'waiting_on_them' ? sql`AND awaiting = 'them'` : kind === 'waiting_on_me' ? sql`AND awaiting = 'me'` : sql``}
    ORDER BY last_activity_at DESC LIMIT ${limit}
  `
  return rowsToState(await base)
}

/**
 * Re-read one thread live and correct its state before it is stated to the
 * user. This is the verification step: "did Sam reply?" never answers from
 * stale rows when the thread itself can be read.
 */
export async function refreshThreadState(
  sql: SQL, userId: string, persona: string, userEmail: string, threadId: string, participant: string,
): Promise<{ status: string; awaiting: Awaiting; lastFrom: string; lastDate: string; lastFromMatchesParticipant: boolean; messages: Array<{ from: string; date: string; subject: string }> }> {
  const thread = await readGmailThreadExact(sql, userId, threadId)
  if (!thread.status.startsWith('success_')) return { status: thread.status, awaiting: 'none', lastFrom: '', lastDate: '', lastFromMatchesParticipant: false, messages: [] }
  const last = thread.messages[thread.messages.length - 1]
  const awaiting = last ? classifyAwaiting(userEmail, participant, last.from, last.subject) : 'none'
  if (last) {
    await upsertThreadState(sql, userId, persona, {
      threadId,
      participant,
      subject: last.subject,
      direction: awaiting === 'them' ? 'outbound' : 'inbound',
      awaiting,
      lastMessageId: last.id,
    })
  }
  return {
    status: thread.status,
    awaiting,
    lastFrom: last?.from || '',
    lastDate: last?.date || '',
    lastFromMatchesParticipant: last ? lastSenderIsParticipant(participant, last.from) : false,
    messages: thread.messages,
  }
}
