/**
 * Real identity for browser form filling. A hired assistant that types
 * "John Smith" into a form it could have looked up is broken twice: the
 * submission is junk AND the user learns the assistant doesn't know them.
 * The worker loads the profile once per job and hands it to the agent loop;
 * the loop's rule is profile values first, a question handoff when a field
 * isn't covered, never an invented value.
 */
import type { SQL } from 'bun'

export type IdentityProfile = {
  name: string | null
  email: string | null
  phone: string | null
  city: string | null
  homeAddress: string | null
  workAddress: string | null
}

export async function loadIdentityProfile(sql: SQL, userId: string, persona: string): Promise<IdentityProfile> {
  const empty: IdentityProfile = { name: null, email: null, phone: null, city: null, homeAddress: null, workAddress: null }
  try {
    const users = (await sql`
      SELECT name, email, phone_e164 FROM hire_users WHERE id = ${userId} LIMIT 1
    `) as Array<{ name: string | null; email: string | null; phone_e164: string | null }>
    const memories = (await sql`
      SELECT key, value FROM hire_memories
      WHERE user_id = ${userId} AND persona = ${persona}
        AND key IN ('preferred_name', 'city', 'home_city', 'email', 'phone')
    `) as Array<{ key: string; value: string }>
    const locations = (await sql`
      SELECT kind, label FROM hire_user_locations
      WHERE user_id = ${userId} AND kind IN ('home', 'work')
    `) as Array<{ kind: string; label: string }>
    const u = users[0]
    const m = new Map(memories.map((r) => [r.key, r.value]))
    const loc = (kind: string) => locations.find((l) => l.kind === kind)?.label?.trim() || null
    return {
      name: u?.name?.trim() || m.get('preferred_name') || null,
      email: u?.email?.trim() || m.get('email') || null,
      phone: u?.phone_e164 || m.get('phone') || null,
      city: m.get('city') || m.get('home_city') || null,
      homeAddress: loc('home'),
      workAddress: loc('work'),
    }
  } catch {
    // A profile read failure degrades to "ask the user", never to inventing.
    return empty
  }
}

/** The prompt block. Empty string when nothing is known — the rule text then
 * still forces a question handoff instead of a made-up value. */
export function formatIdentityForPrompt(p: IdentityProfile): string {
  const lines: string[] = []
  if (p.name) lines.push(`name: ${p.name}`)
  if (p.email) lines.push(`email: ${p.email}`)
  if (p.phone) lines.push(`phone: ${p.phone}`)
  if (p.city) lines.push(`city: ${p.city}`)
  if (p.homeAddress) lines.push(`home address: ${p.homeAddress}`)
  if (p.workAddress) lines.push(`work address: ${p.workAddress}`)
  if (!lines.length) return ''
  return `USER PROFILE (the real values of the person you act for):\n${lines.join('\n')}`
}
