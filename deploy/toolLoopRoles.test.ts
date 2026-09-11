import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * gmi.ts falls back with "Requests ending with a model turn are not supported"
 * when the last message is not a user turn. Every mid-loop instruction in
 * toolLoop must therefore be pushed as role 'user' (the "System note:" prefix
 * convention), never as a trailing system message — that regression silently
 * turned whole turns into "I could not finish this request".
 */
const root = join(import.meta.dir, '..')

describe('tool loop message roles', () => {
  it('never appends a message after a system role push', () => {
    const source = readFileSync(join(root, 'spectrum/shared/toolLoop.ts'), 'utf8')
    const pushes = [...source.matchAll(/messages\.push\(\{[^}]*role:\s*'(\w+)'/gs)]
    const roles = pushes.map((m) => m[1]!)
    // A system push is only safe as part of the leading preamble; anything
    // after the loop starts must be assistant or user.
    const loopStart = source.indexOf('for (let step = 0; step <= maxSteps; step++)')
    expect(loopStart).toBeGreaterThan(0)
    const afterLoop = source.slice(loopStart)
    const trailingSystem = [...afterLoop.matchAll(/messages\.push\(\{[^}]*role:\s*'system'/gs)]
    expect(trailingSystem).toEqual([])
    expect(roles.filter((r) => r === 'system').length).toBeGreaterThan(0)
  })

  it('prefixes every in-loop user instruction with System note', () => {
    const source = readFileSync(join(root, 'spectrum/shared/toolLoop.ts'), 'utf8')
    const loopStart = source.indexOf('for (let step = 0; step <= maxSteps; step++)')
    const afterLoop = source.slice(loopStart)
    // Multi-line content fields that are instructions, not tool payloads.
    const injected = [...afterLoop.matchAll(/role:\s*'user',\s*\n?\s*content:\s*\n?\s*'([^']{20,})/g)]
      .map((m) => m[1]!)
      .filter((text) => !text.startsWith('Tool response'))
    for (const text of injected) {
      expect(text).toStartWith('System note:')
    }
  })
})
