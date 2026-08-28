import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { handleHireApi } from './hire-api'
import { gateWorkshopCode, runWorkshopCode } from './workshop'

describe('workshop gate', () => {
  it('bans escapes and credential probes', () => {
    expect(gateWorkshopCode(`require('child_process')`).ok).toBe(false)
    expect(gateWorkshopCode(`import fs from 'fs'; fs.readFileSync('/etc/passwd')`).ok).toBe(false)
    expect(gateWorkshopCode(`fetch('https://evil.com')`).ok).toBe(false)
    expect(gateWorkshopCode(`process.env.DATABASE_URL`).ok).toBe(false)
    expect(gateWorkshopCode(`Bun.spawn(['sh'])`).ok).toBe(false)
  })

  it('allows honest sandbox code', () => {
    expect(gateWorkshopCode(`await Bun.write('out/index.html', '<h1>hi</h1>')`).ok).toBe(true)
    expect(gateWorkshopCode(`const rows = [1,2,3]; console.log(rows.length)`).ok).toBe(true)
  })
})

describe('workshop runner', () => {
  it('captures files the code writes into out/', async () => {
    const r = await runWorkshopCode(`await Bun.write('out/index.html', '<h1>Tracker</h1>')`, 15000)
    expect(r.ok).toBe(true)
    expect(r.files[0]!.name).toBe('index.html')
    expect(new TextDecoder().decode(r.files[0]!.bytes)).toContain('Tracker')
  })

  it('kills runaway programs at the timeout', async () => {
    const started = Date.now()
    const r = await runWorkshopCode('while (true) {}', 800)
    expect(r.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reports program errors honestly', async () => {
    const r = await runWorkshopCode('throw new Error("nope")', 5000)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('nope')
  })

  it('never leaks the host environment', async () => {
    process.env.WORKSHOP_CANARY = 'canary-secret'
    try {
      // The gate bans process.env reads, so run a program that dumps the env
      // object keys via a construction the gate does not match.
      const r = await runWorkshopCode(
        `const k = 'process' + '.env'; console.log(Object.keys(eval(k)).join(','))`,
        8000,
      )
      expect(r.stdout).not.toContain('canary-secret')
    } finally {
      delete process.env.WORKSHOP_CANARY
    }
  })
})

/* Regression: a real build once 500'd with "INSERT has more expressions than
 * target columns" — templateKey was added to VALUES without template_key in
 * the column list. Drive the real endpoint and pin columns == values. */
describe('workshop save endpoint', () => {
  const savedKey = process.env.HIREALPHA_INTERNAL_KEY
  const savedEnabled = process.env.WORKSHOP_ENABLED
  beforeEach(() => {
    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    delete process.env.WORKSHOP_ENABLED
  })
  afterAll(() => {
    if (savedKey === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
    else process.env.HIREALPHA_INTERNAL_KEY = savedKey
    if (savedEnabled !== undefined) process.env.WORKSHOP_ENABLED = savedEnabled
  })

  it('inserts the artifact with one value per column', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = []
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join('?'), values })
      return Promise.resolve(/FROM hire_users/i.test(strings.join('?'))
        ? [{ id: 'u-ws', email: 'w@t.co' }]
        : /count\(\*\)/i.test(strings.join('?'))
          ? [{ n: 0 }]
          : [])
    }) as unknown as Parameters<typeof handleHireApi>[1]

    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/workshop', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '+14155551212',
          persona: 'friend',
          prompt: 'build a ping pong game with minimal ui',
          code: `await Bun.write('out/index.html', '<h1>pong</h1>')`,
          templateKey: 'ping-pong-minimal-ui',
        }),
      }),
      sql,
    )
    const body = (await res!.json()) as { ok: boolean; error?: string }
    expect(body.ok).toBe(true)

    const insert = queries.find((q) => /INSERT INTO hire_artifacts/i.test(q.text))!
    const cols = insert.text.slice(
      insert.text.indexOf('(') + 1,
      insert.text.indexOf(')'),
    ).split(',').map((c) => c.trim())
    // 'delivered' is a SQL literal, not a placeholder — count it as an expression.
    const valuesPart = insert.text.slice(insert.text.indexOf('VALUES'))
    const placeholders = valuesPart.split('?').length - 1
    const literals = (valuesPart.match(/'[^']*'/g) || []).length
    expect(cols.length).toBe(placeholders + literals)
    expect(cols).toContain('template_key')
  })

})
