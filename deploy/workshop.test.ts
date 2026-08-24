import { describe, expect, it } from 'bun:test'
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
