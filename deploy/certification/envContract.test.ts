import { describe, expect, it } from 'bun:test'
import { validateProductionBrowserWorker } from './envContract'

const READY = {
  DATABASE_URL: 'postgres://db/hirealpha',
  KERNEL_API_KEY: 'kernel-test',
  GMI_API_KEY: 'gmi-test',
  OPENBAO_ADDR: 'https://bao.example.com',
  OPENBAO_TOKEN: 'bao-test',
  HIREALPHA_APP_URL: 'https://hirealpha.chat',
  KERNEL_AGENT_DRIVER: 'browser-use',
  KERNEL_TELEMETRY: 'true',
}

describe('production browser-worker readiness', () => {
  it('accepts the canonical Kernel + Browser Use path with safe defaults', () => {
    expect(validateProductionBrowserWorker(READY)).toEqual({ ok: true, problems: [] })
  })

  it('fails closed when canonical records, receipt verification, or telemetry are disabled', () => {
    const result = validateProductionBrowserWorker({
      ...READY,
      HIREALPHA_TASK_RECORD: '0',
      HIREALPHA_RECEIPT_GATE: 'false',
      KERNEL_TELEMETRY: 'off',
    })
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'unsafe:HIREALPHA_RECEIPT_GATE',
      'unsafe:HIREALPHA_TASK_RECORD',
      'unsafe:KERNEL_TELEMETRY',
    ])
  })

  it('names absent prerequisites without exposing any configured values', () => {
    const result = validateProductionBrowserWorker({})
    expect(result.ok).toBe(false)
    expect(result.problems).toContain('missing:DATABASE_URL')
    expect(result.problems).toContain('missing:KERNEL_API_KEY')
    expect(result.problems.join(' ')).not.toContain('postgres://')
  })
})
