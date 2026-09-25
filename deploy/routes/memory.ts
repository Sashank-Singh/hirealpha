import type { SQL } from 'bun'
import { isPersona, type Persona } from '../personas'
import { json } from '../utils/http'
import { getUserByPhone } from '../db/users'
import { loadMemories, upsertMemories } from '../memory/store'
import { userKeyBrokerFromEnv } from '../../services/trust/userKeyBroker'
import { parseChatExport } from '../../spectrum/shared/smartFeatures'

export async function handleMemoryRoutes(
  req: Request,
  sql: SQL,
  options: {
    internalOk: (r: Request) => boolean
    rememberUserTimezone?: (sql: SQL, userId: string, raw: string, persona?: Persona) => Promise<string | null>
  },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/internal/memory' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      facts?: Array<{ key?: string; value?: string }>
    }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const facts = (body.facts || [])
      .filter((f) => f && f.key && f.value)
      .map((f) => ({ key: String(f.key), value: String(f.value) }))
    /* Re-stating a fact revives it: the tombstone must not swallow it again. */
    if (facts.length) {
      await sql`
        DELETE FROM hire_memory_tombstones
        WHERE user_id = ${user.id} AND persona = ${body.persona}
          AND key IN ${sql(facts.map((f) => f.key.toLowerCase()))}
      `.catch(() => undefined)
    }
    /* Report which keys actually landed. */
    const stored: string[] = []
    const brokered = !!userKeyBrokerFromEnv()
    try {
      await upsertMemories(sql, user.id, body.persona, facts)
      stored.push(...facts.map((f) => f.key))
    } catch (err) {
      console.warn('[memory] upsert before tz failed', err)
    }
    const readBack = brokered
      ? await sql`
          SELECT memory_key AS key FROM memory_records
          WHERE user_id = ${user.id} AND persona = ${body.persona} AND deleted_at IS NULL
        `.catch(() => [] as Array<{ key: string }>)
      : await sql`
          SELECT key FROM hire_memories WHERE user_id = ${user.id} AND persona = ${body.persona}
        `.catch(() => [] as Array<{ key: string }>)
    const present = new Set((readBack as Array<{ key: string }>).map((r) => String(r.key || '').toLowerCase()))
    const dropped = facts.map((f) => f.key).filter((k) => !present.has(k.toLowerCase()))
    const tzFact = facts.find((f) => f.key.toLowerCase() === 'timezone')
    if (tzFact && options.rememberUserTimezone) {
      await options.rememberUserTimezone(sql, user.id, tzFact.value, body.persona as Persona)
    }
    const genFact = facts.find((f) => ['generation', 'age', 'birth_year', 'tone'].includes(f.key.toLowerCase()))
    if (genFact) {
      await sql`
        INSERT INTO hire_context (user_id, persona, fields, updated_at)
        VALUES (${user.id}, ${body.persona}, ${JSON.stringify({ [genFact.key.toLowerCase()]: genFact.value })}::jsonb, now())
        ON CONFLICT (user_id, persona)
        DO UPDATE SET fields = hire_context.fields || ${JSON.stringify({ [genFact.key.toLowerCase()]: genFact.value })}::jsonb, updated_at = now()
      `
    }
    return json({
      ok: true,
      stored,
      dropped,
      memories: await loadMemories(sql, user.id, body.persona as Persona, 12),
    })
  }

  if (path === '/api/internal/chat-import' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      text?: string
    }
    if (!body.phone || !isPersona(body.persona || '')) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const people = parseChatExport(String(body.text || ''))
    let lines = 0
    for (const p of people) {
      const payload = p.lines.slice(0, 30).join('\n').slice(0, 3000)
      if (!payload.trim()) continue
      lines += p.lines.length
      const key = `chat:${p.name}`
      await upsertMemories(sql, user.id, body.persona as Persona, [
        { key, value: payload, durable: true },
      ])
    }
    return json({ ok: true, people: people.length, lines })
  }

  if (path === '/api/internal/travel' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      dest?: string
      tz?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.dest || '').trim()) {
      return json({ error: 'phone, persona, and dest required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const dest = String(body.dest).trim().slice(0, 80)
    const tz = String(body.tz || '').slice(0, 60)
    await upsertMemories(sql, user.id, body.persona as Persona, [
      { key: 'travel_dest', value: dest, durable: true },
      ...(tz ? [{ key: 'travel_tz', value: tz, durable: true }] : []),
    ])
    return json({ ok: true, dest, tz })
  }

  return null
}
