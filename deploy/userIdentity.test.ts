import { describe, expect, it } from 'bun:test'
import { formatIdentityForPrompt, loadIdentityProfile } from './userIdentity'

// Minimal fake of Bun's tagged-template SQL: the query text is the strings
// joined, so we route on a substring and return canned rows.
function fakeSql(handlers: Array<{ match: string; rows: unknown[] }>) {
  return async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const q = strings.join(' ')
    for (const h of handlers) if (q.includes(h.match)) return h.rows
    return []
  }
}

describe('userIdentity', () => {
  it('formats the profile block with real values only', () => {
    const text = formatIdentityForPrompt({
      name: 'Sashank Singh',
      email: 'sashank@example.com',
      phone: '+12163032166',
      city: 'San Jose',
      homeAddress: '123 Main St',
      workAddress: null,
    })
    expect(text).toContain('USER PROFILE')
    expect(text).toContain('name: Sashank Singh')
    expect(text).toContain('home address: 123 Main St')
    expect(text).not.toContain('work address')
  })

  it('empty profile yields no block (the rules then force asking)', () => {
    const text = formatIdentityForPrompt({ name: null, email: null, phone: null, city: null, homeAddress: null, workAddress: null })
    expect(text).toBe('')
  })

  it('loads name/email/phone from hire_users and locations by kind', async () => {
    const sql = fakeSql([
      { match: 'FROM hire_users', rows: [{ name: 'Sashank', email: 's@example.com', phone_e164: '+15550001111' }] },
      { match: 'FROM hire_memories', rows: [{ key: 'city', value: 'San Jose' }] },
      { match: 'FROM hire_user_locations', rows: [{ kind: 'home', label: 'Home, San Jose' }] },
    ]) as never
    const p = await loadIdentityProfile(sql, 'u1', 'friend')
    expect(p.name).toBe('Sashank')
    expect(p.email).toBe('s@example.com')
    expect(p.city).toBe('San Jose')
    expect(p.homeAddress).toBe('Home, San Jose')
  })

  it('memory preferred_name fills the gap when hire_users.name is null', async () => {
    const sql = fakeSql([
      { match: 'FROM hire_users', rows: [{ name: null, email: null, phone_e164: null }] },
      { match: 'FROM hire_memories', rows: [{ key: 'preferred_name', value: 'Sashu' }] },
      { match: 'FROM hire_user_locations', rows: [] },
    ]) as never
    const p = await loadIdentityProfile(sql, 'u1', 'friend')
    expect(p.name).toBe('Sashu')
  })

  it('a DB failure degrades to an empty profile, never a throw', async () => {
    const boom = (async () => { throw new Error('db down') }) as never
    const p = await loadIdentityProfile(boom, 'u1', 'friend')
    expect(p.name).toBeNull()
    expect(formatIdentityForPrompt(p)).toBe('')
  })
})
