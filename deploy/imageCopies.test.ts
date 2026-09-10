import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * Every relative import reachable from a Docker entry point must be COPY'd into
 * the image. Missing files crash the container at boot, after the build has
 * already succeeded and after prod has rolled back — the failure mode that
 * cost several deploys (skills.ts, demoData.ts, e2bExecutor.ts).
 */
const root = join(import.meta.dir, '..')

function copySources(dockerfile: string): Array<{ repo: string; dest: string }> {
  const text = readFileSync(join(root, dockerfile), 'utf8')
  return [...text.matchAll(/^COPY\s+(?:--from=\S+\s+)?(\S+)\s+(\S+)\s*$/gm)]
    .map((m) => ({ repo: join(root, m[1]!), dest: m[2]! }))
}

function inImage(copies: Array<{ repo: string }>, repoPath: string): boolean {
  return copies.some((c) => repoPath === c.repo || repoPath.startsWith(c.repo + '/'))
}

/** Walk relative imports from the entry points, stopping at node_modules. */
function reachableFrom(copies: Array<{ repo: string }>, entries: string[]): string[] {
  const seen = new Set<string>()
  const missing = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(file), match[1]!)
      const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
        .find((candidate) => existsSync(candidate) && !candidate.includes('node_modules'))
      if (!hit) continue
      if (!inImage(copies, hit)) missing.add(relative(root, hit))
      walk(hit)
    }
  }
  for (const entry of entries) walk(join(root, entry))
  return [...missing].sort()
}

describe('docker image file sets', () => {
  it('web image copies every module reachable from its entry points', () => {
    const copies = copySources('Dockerfile.web')
    expect(reachableFrom(copies, ['deploy/web-server.ts', 'deploy/browserWorker.ts', 'deploy/migrate.ts'])).toEqual([])
  })

  it('worker image copies every module reachable from its entry point', () => {
    const copies = copySources('Dockerfile.worker')
    expect(reachableFrom(copies, ['deploy/browserWorker.ts'])).toEqual([])
  })
})
