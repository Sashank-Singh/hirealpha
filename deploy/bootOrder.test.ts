import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A `const` read by the boot-time catch-up has to be initialized before the
 * catch-up runs, and the catch-up has to start before the message stream —
 * `for await (const incoming of app.messages)` never returns, so module
 * evaluation suspends there for the life of the process and anything declared
 * after it is never initialized at all.
 *
 * This has now regressed twice. First the call sat above the constants and boot
 * threw "Cannot access 'CATCHUP_WINDOW_MS' before initialization"; the fix
 * moved the constants but left them below the stream loop, and the deploy log
 * on 2026-09-19 showed the identical error coming back — meaning a message
 * delivered during that restart was lost, which is the one thing the catch-up
 * exists to prevent. The shape is asserted here so the next move of these lines
 * fails a test instead of a deploy.
 */
const source = readFileSync(join(import.meta.dir, '..', 'spectrum', 'alpha', 'src', 'index.ts'), 'utf8')

describe('the friend bot boots the catch-up in the right order', () => {
  it('initializes the catch-up constants before the call and the stream loop', () => {
    const windowMs = source.indexOf('const CATCHUP_WINDOW_MS')
    const max = source.indexOf('const CATCHUP_MAX')
    const call = source.indexOf('void catchUpMissedMessages()')
    const stream = source.indexOf('for await (const incoming of app.messages)')
    expect(windowMs).toBeGreaterThan(-1)
    expect(max).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(-1)
    expect(stream).toBeGreaterThan(-1)
    expect(windowMs).toBeLessThan(call)
    expect(max).toBeLessThan(call)
    expect(windowMs).toBeLessThan(stream)
    expect(max).toBeLessThan(stream)
  })

  it('keeps the stream loop last, so nothing after it is stranded dead code', () => {
    const stream = source.indexOf('for await (const incoming of app.messages)')
    const tail = source.slice(stream)
    // Only declarations may follow: a statement that has to run would never run.
    expect(tail).not.toMatch(/^void |^await |^if \(/m)
  })
})
