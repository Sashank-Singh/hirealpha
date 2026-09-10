import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Dockerfile.web builds with `npm ci`, which hard-fails when package.json and
 * package-lock.json disagree. Adding a dependency through bun (which writes
 * bun.lock) has silently broken every production deploy twice, so the lock
 * files are checked here instead of being discovered in a build log.
 */
const root = join(import.meta.dir, '..')

type Lock = {
  lockfileVersion?: number
  packages?: Record<string, { version?: string; dev?: boolean }>
  dependencies?: Record<string, unknown>
}

function readJson(path: string): Lock {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Lock
}

describe('dependency lock files', () => {
  it('package.json and package-lock.json agree on every dependency', () => {
    const pkg = readJson('package.json') as unknown as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const lock = readJson('package-lock.json')
    const rootEntry = lock.packages?.['']
    expect(rootEntry).toBeDefined()

    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ])
    const locked = new Set([
      ...Object.keys((rootEntry as unknown as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...Object.keys((rootEntry as unknown as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    ])

    const missingFromLock = [...declared].filter((name) => !locked.has(name)).sort()
    expect(missingFromLock).toEqual([])

    // The lock must also carry an installed entry for each declared package,
    // which is what `npm ci` actually verifies.
    const absent = [...declared].filter((name) => !lock.packages?.[`node_modules/${name}`]).sort()
    expect(absent).toEqual([])

    // npm ci also rejects a lock whose installed version does not satisfy the
    // declared range (this is how `playwright@1.62.1` vs `^1.63.0` broke prod).
    const mismatched: string[] = []
    for (const [name, range] of [...Object.entries(pkg.dependencies ?? {}), ...Object.entries(pkg.devDependencies ?? {})]) {
      const installed = lock.packages?.[`node_modules/${name}`]?.version
      if (!installed) continue
      const minimum = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/.exec(range)
      if (!minimum) continue // workspace:, file:, *, or a complex range
      const [, major, minor, patch] = minimum
      const actual = installed.split('.').map(Number)
      const wanted = [Number(major), Number(minor), Number(patch)]
      const satisfies = range.startsWith('^')
        ? actual[0] === wanted[0] && (actual[1] > wanted[1]! || (actual[1] === wanted[1] && actual[2]! >= wanted[2]!))
        : range.startsWith('~')
          ? actual[0] === wanted[0] && actual[1] === wanted[1] && actual[2]! >= wanted[2]!
          : installed === range.replace(/^[\^~]/, '')
      if (!satisfies) mismatched.push(`${name}: lock ${installed} does not satisfy ${range}`)
    }
    expect(mismatched).toEqual([])
  })

  it('builds the dev image with a lock-consistent install', () => {
    const dockerfile = readFileSync(join(root, 'Dockerfile.web'), 'utf8')
    // If the build ever switches to bun install, this test should be revisited
    // rather than silently passing on a stale assertion.
    expect(dockerfile).toContain('npm ci')
    expect(readJson('package-lock.json').lockfileVersion).toBeGreaterThanOrEqual(2)
  })
})
