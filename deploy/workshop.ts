/**
 * Workshop runner: executes Alpha-generated code in a locked-down subprocess
 * and returns what it produced.
 *
 * v0 threat model (honest): this runs on the same box as the app server, for a
 * single trusted user. The gates below are seatbelts, not a prison — generated
 * code gets a temp dir, a stripped environment, no network modules, a timeout,
 * and nothing else. When a second user arrives, this whole module moves to a
 * dedicated sandbox box (Oracle free tier / Docker) and nothing else changes,
 * because the runner already talks to the app only through its return value.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const WORKSHOP_TIMEOUT_MS = 30_000
export const WORKSHOP_MAX_FILE_BYTES = 5 * 1024 * 1024
export const WORKSHOP_MAX_STDOUT_BYTES = 100 * 1024
const ALLOWED_FILE_EXT = /\.(html?|css|js|mjs|json|csv|tsv|txt|md|svg|png|jpe?g|pdf)$/i

/** Patterns generated code may not contain. Seatbelt against obvious escapes;
 * the stripped env + timeout are the real walls. */
const BANNED: Array<[RegExp, string]> = [
  [/child_process/, 'child_process'],
  [/worker_threads/, 'worker_threads'],
  [/node:vm|require\(\s*['"]vm['"]\s*\)|from\s+['"]vm['"]/, 'vm'],
  [/\brequire\(\s*['"](net|tls|dgram|http|https|http2|dns)['"]\s*\)/, 'network module'],
  [/from\s+['"](net|tls|dgram|http|https|http2|dns)['"]/, 'network module'],
  [/\bfetch\s*\(/, 'fetch (no network in the sandbox)'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/WebSocket/, 'WebSocket'],
  [/Bun\.(spawn|connect|serve|listen)/, 'Bun.spawn/serve'],
  [/process\.env/, 'process.env (the sandbox has no secrets to read)'],
  [/\/etc\//, 'system path'],
  [/\bDB_URL|DATABASE_URL|API_KEY|SECRET\b/i, 'credential probe'],
]

export function gateWorkshopCode(code: string): { ok: true } | { ok: false; reason: string } {
  for (const [re, what] of BANNED) {
    if (re.test(code)) return { ok: false, reason: `The sandbox does not allow ${what}.` }
  }
  if (code.length > 200_000) return { ok: false, reason: 'That program is too large for the sandbox.' }
  return { ok: true }
}

export type WorkshopRun = {
  ok: boolean
  stdout: string
  error?: string
  files: Array<{ name: string; bytes: Uint8Array }>
}

/** Run generated JS in a fresh temp dir with a stripped env. Anything the code
 * writes into `out/` comes back as files; the dir itself is always removed. */
export async function runWorkshopCode(code: string, timeoutMs = WORKSHOP_TIMEOUT_MS): Promise<WorkshopRun> {
  const gate = gateWorkshopCode(code)
  if (!gate.ok) return { ok: false, stdout: '', error: gate.reason, files: [] }

  const dir = await mkdtemp(join(tmpdir(), 'workshop-'))
  try {
    await mkdir(join(dir, 'out'), { recursive: true })
    await writeFile(join(dir, 'main.js'), code)
    const proc = Bun.spawn({
      cmd: ['bun', 'main.js'],
      cwd: dir,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: dir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const killTimer = setTimeout(() => {
      try {
        proc.kill(9)
      } catch {
        /* already exited */
      }
    }, timeoutMs)
    const [stdoutRaw, stderrRaw] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    clearTimeout(killTimer)

    const stdout = stdoutRaw.slice(0, WORKSHOP_MAX_STDOUT_BYTES)
    if (exitCode !== 0) {
      return { ok: false, stdout, error: stderrRaw.slice(0, 4000) || `Exited with code ${exitCode}`, files: [] }
    }

    const files: WorkshopRun['files'] = []
    let total = 0
    for (const name of await readdir(join(dir, 'out'))) {
      if (!ALLOWED_FILE_EXT.test(name)) continue
      const bytes = await readFile(join(dir, 'out', name))
      if (bytes.byteLength > WORKSHOP_MAX_FILE_BYTES) continue
      total += bytes.byteLength
      if (total > 10 * 1024 * 1024) break
      files.push({ name, bytes })
    }
    return { ok: true, stdout, files }
  } catch (err) {
    return { ok: false, stdout: '', error: err instanceof Error ? err.message : 'Runner failed', files: [] }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The prompt template the bot uses to turn a user ask into sandbox code. */
export function workshopPlannerPrompt(ask: string): string {
  return [
    'You generate a single-file JavaScript program for a sandbox.',
    'Sandbox rules: Bun runtime, NO network, NO environment variables, no child processes.',
    'Do useful work, then WRITE every output file into the out/ directory (create it if needed), e.g. Bun.write("out/index.html", html).',
    'For a page or tracker, produce one self-contained out/index.html with inline CSS/JS and realistic sample data the user can edit later in the file.',
    'CRITICAL: the app opens in Safari on an iPhone. Include <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">.',
    'MOBILE SAFE-AREAS & PADDING: Mobile browsers have a top status bar/notch and a bottom search/tab bar & home bar. Always style with safe area insets: padding-top: max(16px, env(safe-area-inset-top, 0px)); padding-bottom: max(32px, env(safe-area-inset-bottom, 0px)); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); box-sizing: border-box; min-height: 100dvh;. Never place buttons flush against the bottom edge where Safari UI covers them.',
    'Never require a keyboard, hover, or arrow keys; games get on-screen buttons, tap, or drag controls.',
    'Reply with JSON only, no markdown: {"title": "short name", "code": "<the whole program>"}',
    '',
    `Build this: ${ask}`,
  ].join('\n')
}

/** Purge delivered artifacts past their TTL (kept ones never expire). */
export async function sweepExpiredArtifacts(
  sql: { (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> },
  artifactsDir: string,
): Promise<number> {
  const expired = (await sql`
    SELECT id, user_id FROM hire_artifacts
    WHERE state = 'delivered' AND expires_at IS NOT NULL AND expires_at < now()
  `) as Array<{ id: string; user_id: string }>
  for (const row of expired) {
    await rm(join(artifactsDir, row.user_id, row.id), { recursive: true, force: true })
    await sql`DELETE FROM hire_artifacts WHERE id = ${row.id}`
  }
  return expired.length
}
