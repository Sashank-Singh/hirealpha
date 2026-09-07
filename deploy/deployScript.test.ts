import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('legacy deployment refuses false success', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hirealpha-release-test-'))
    for (const name of ['scripts', 'dist', 'bin']) mkdirSync(join(dir, name))
    writeFileSync(join(dir, 'scripts/deploy-prod.sh'), readFileSync(join(import.meta.dir, '../scripts/deploy-prod.sh')))
    writeFileSync(join(dir, 'dist/index.html'), '<script src="/assets/index-test1234.js"></script>')
    const commands: Record<string, string> = {
      git: 'case "$1" in status) printf "%s" "$TEST_DIRTY";; rev-parse) echo revision;; esac',
      npm: 'exit 0', rsync: 'exit 0', sleep: 'exit 0',
      ssh: 'case "$*" in *restart*) test "${TEST_FAIL_RESTART:-0}" = 0;; *) exit 0;; esac',
      curl: 'case "$*" in *healthz*) printf "%s" "${TEST_HEALTH:-200}";; *"-o /dev/null"*) exit 0;; *) printf "%s" "${TEST_PAGE:-/assets/index-test1234.js}";; esac',
    }
    for (const [name, body] of Object.entries(commands)) {
      const file = join(dir, 'bin', name)
      writeFileSync(file, `#!/bin/sh\n${body}\n`)
      chmodSync(file, 0o755)
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  async function run(extra: Record<string, string> = {}) {
    const proc = Bun.spawn(['/bin/bash', join(dir, 'scripts/deploy-prod.sh')], {
      env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, ...extra }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code, output: out + err }
  }
  it('rejects dirty local releases', async () => {
    const result = await run({ TEST_DIRTY: ' M source.ts' })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('Commit or isolate')
  })
  it('fails when the service restart fails', async () => {
    const result = await run({ TEST_FAIL_RESTART: '1' })
    expect(result.code).not.toBe(0)
    expect(result.output).not.toContain('Deployed revision')
  })
  it('fails when health never recovers', async () => {
    const result = await run({ TEST_HEALTH: '503' })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('health check did not recover')
  })
  it('fails when the old bundle is still served', async () => {
    const result = await run({ TEST_PAGE: '/assets/index-old.js' })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('different client bundle')
  })
  it('succeeds only after restart, health and bundle checks pass', async () => {
    const result = await run()
    expect(result.code).toBe(0)
    expect(result.output).toContain('Deployed revision revision')
  })
})
