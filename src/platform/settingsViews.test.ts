/**
 * Which sections each sidebar view renders.
 *
 * This is the bug that shipped: scoped settings were added to the nav
 * and the router, but nothing scoped them, so both rendered every section at
 * once and were indistinguishable from Workspace ("the memory button doesn't
 * open anything"). Hiding by CSS was the original approach and is what broke —
 * a view with no rule leaks every section. Sections are now gated in JSX, and
 * this asserts the mapping holds.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceViewFromParams } from './workspaceNavigation'

const source = readFileSync(join(import.meta.dir, 'SettingsSheet.tsx'), 'utf8')
const shell = readFileSync(join(import.meta.dir, 'WorkspaceShell.tsx'), 'utf8')

/** Sections that must render only in the named view. */
const SCOPED: Array<[section: string, view: string]> = [
  ['payments-section', 'payments'],
  ['vault-section', 'vault'],
  ['memory-section', 'memory'],
]

describe('workspace view section scoping', () => {
  for (const [section, view] of SCOPED) {
    it(`${section} renders only in the ${view} view`, () => {
      const marker = `<section id="${section}"`
      const at = source.indexOf(marker)
      expect(at).toBeGreaterThan(-1)
      // The guard sits immediately above the section it protects.
      const before = source.slice(Math.max(0, at - 120), at)
      expect(before).toContain(`{view === '${view}' && (`)
    })
  }

  it('keeps the account section outside every gate', () => {
    // Account must render in every view, so its section is never inside a
    // `view === '…'` block. Assert both that it exists and that the nearest
    // preceding gate has already closed.
    const accountAt = source.indexOf('{/* Account */}')
    expect(accountAt).toBeGreaterThan(-1)
    const before = source.slice(0, accountAt)
    const lastOpen = before.lastIndexOf("{view === '")
    const lastClose = before.lastIndexOf(')}')
    expect(lastClose).toBeGreaterThan(lastOpen)
  })

  it('has a JSX condition for every view the router can produce', () => {
    const views = ['workspace', 'vault', 'payments', 'memory']
    for (const view of views) {
      if (view === 'workspace') continue // workspace is the default and owns the chrome
      expect(source).toContain(`{view === '${view}' && (`)
    }
  })

  it('does not expose the retired trust and audit view', () => {
    expect(shell).not.toContain("id: 'trust'")
    expect(source).not.toContain('trust-section')
    expect(workspaceViewFromParams(new URLSearchParams('tab=trust'))).toBe('workspace')
  })
})
