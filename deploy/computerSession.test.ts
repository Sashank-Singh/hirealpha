import { describe, expect, it } from 'bun:test'
import { handleHireApi } from './hire-api'
import { generateSessionViewToken } from './browserJobs'

function fakeSql(rows: any[] = []) {
  const queries: { text: string; values: any[] }[] = []
  const fn: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.reduce((acc, str, i) => acc + str + (values[i] !== undefined ? `$${i + 1}` : ''), '')
    queries.push({ text, values })
    return rows
  }
  return { sql: fn, queries }
}

describe('/api/computer/session/:id endpoint', () => {
  const USER_ID = '11111111-1111-1111-1111-111111111111'
  const JOB_ID = '22222222-2222-2222-2222-222222222222'

  it('rejects access when no token or session cookie is provided', async () => {
    const { sql } = fakeSql([
      {
        id: JOB_ID,
        user_id: USER_ID,
        persona: 'friend',
        phone_e164: '+14155550100',
        kind: 'task',
        url: 'https://united.com',
        steps: null,
        goal: 'Check flight UA123',
        status: 'running',
        attempts: 1,
        result: null,
        error: null,
        approval_id: null,
      },
    ])

    const req = new Request(`https://hirealpha.chat/api/computer/session/${JOB_ID}`, {
      method: 'GET',
    })

    const res = await handleHireApi(req, sql)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
    const data = await res?.json()
    expect(data.error).toContain('Unauthorized')
  })

  it('rejects access when an invalid or forged token is provided', async () => {
    const { sql } = fakeSql([
      {
        id: JOB_ID,
        user_id: USER_ID,
        persona: 'friend',
        phone_e164: '+14155550100',
        kind: 'task',
        url: 'https://united.com',
        steps: null,
        goal: 'Check flight UA123',
        status: 'running',
        attempts: 1,
        result: null,
        error: null,
        approval_id: null,
      },
    ])

    const req = new Request(`https://hirealpha.chat/api/computer/session/${JOB_ID}?token=bad-token`, {
      method: 'GET',
    })

    const res = await handleHireApi(req, sql)
    expect(res?.status).toBe(403)
  })

  it('allows access and returns live stream details when valid signed token is provided', async () => {
    const token = generateSessionViewToken(JOB_ID, USER_ID)
    const { sql } = fakeSql([
      {
        id: JOB_ID,
        user_id: USER_ID,
        persona: 'friend',
        phone_e164: '+14155550100',
        kind: 'task',
        url: 'https://united.com',
        steps: [{ action: 'goto', value: 'https://united.com' }],
        goal: 'Check flight UA123',
        status: 'running',
        attempts: 1,
        result: null,
        error: null,
        approval_id: null,
      },
    ])

    const req = new Request(`https://hirealpha.chat/api/computer/session/${JOB_ID}?token=${token}`, {
      method: 'GET',
    })

    const res = await handleHireApi(req, sql)
    expect(res?.status).toBe(200)
    const data = await res?.json()
    expect(data.ok).toBe(true)
    expect(data.session.id).toBe(JOB_ID)
    expect(data.session.status).toBe('running')
    expect(data.session.goal).toBe('Check flight UA123')
    expect(data.session.streamUrl).toContain('browser.hirealpha.chat/vnc/')
  })

  it('returns 404 when the session does not exist', async () => {
    const { sql } = fakeSql([]) // empty results
    const req = new Request(`https://hirealpha.chat/api/computer/session/${JOB_ID}?token=any`, {
      method: 'GET',
    })

    const res = await handleHireApi(req, sql)
    expect(res?.status).toBe(404)
  })
})
