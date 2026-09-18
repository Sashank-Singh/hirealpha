import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
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
      // Files only: `base` can be a directory (an imported folder), and reading
      // one as a module throws EISDIR instead of reporting a missing COPY.
      const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
        .find((candidate) => existsSync(candidate) && !candidate.includes('node_modules') && statSync(candidate).isFile())
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

  /* The bot image copies `spectrum/shared` wholesale and only two files out of
   * `deploy/`. Nothing checked that — so when a shared module imported
   * `../../deploy/jsonExtract`, the build succeeded, the container died with
   * "Cannot find module" and prod rolled back. The three bots are the entry
   * points; the shared tree is where the coupling creeps in. */
  it('bot image copies every module reachable from the three bots', () => {
    const copies = copySources('Dockerfile')
    expect(reachableFrom(copies, [
      'spectrum/alpha/src/index.ts',
      'spectrum/alpha-coworker/src/index.ts',
      'spectrum/alpha-cofounder/src/index.ts',
    ])).toEqual([])
  })
})

describe('the trvl install recipe', () => {
  /* Live failure 2026-09-18: the tarball was saved as trvl.tar.gz while the
   * checksum file names trvl_1.21.6_linux_amd64.tar.gz, so `sha256sum -c` could
   * not find the file, the build died in 30 seconds and the whole Web deploy
   * failed. The download must carry the asset's own name. */
  it('downloads the asset under the name the checksum file uses', () => {
    const dockerfile = readFileSync(join(root, 'Dockerfile.web'), 'utf8')
    const block = dockerfile.slice(dockerfile.indexOf('ARG TRVL_VERSION'), dockerfile.indexOf('ENV TRVL_BIN'))
    expect(block).toContain('asset="trvl_')
    expect(block).toContain('-o "$asset"')
    expect(block).toContain('grep "$asset" checksums.txt | sha256sum -c -')
    expect(block).not.toMatch(/-o \/tmp\/trvl\.tar\.gz/)
    expect(block).toContain('tar xzf "$asset"')
  })
})
