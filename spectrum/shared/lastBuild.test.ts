import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastBuildFor, loadMemory, recordDeliveredBuild, type ThreadMemory } from './memory'

/* Live, 2026-09-19: a trivia game was delivered, the container was replaced by
 * the next deploy, and the follow-up "add a 30 second timer to the game" was
 * refused — "there's no game in this thread for me to update" — because the /b/
 * link and the artifact id both live in the thread file, which dies with the
 * container. The fact store survives, and the live payload re-hydrates it. */
const mem = (over: Partial<ThreadMemory>): ThreadMemory => ({ history: [], facts: [], ...over } as ThreadMemory)

describe('lastBuildFor', () => {
  it('prefers the thread file when it still has the build', () => {
    const found = lastBuildFor(mem({ lastBuild: { artifactId: 'a1', url: 'https://hirealpha.chat/b/a1' } }))
    expect(found).toEqual({ artifactId: 'a1', url: 'https://hirealpha.chat/b/a1' })
  })

  it('falls back to the durable fact after the thread file is gone', () => {
    const facts = [{ key: 'last_build_url', value: 'a9|https://hirealpha.chat/b/a9' }]
    expect(lastBuildFor(mem({ facts }))).toEqual({ artifactId: 'a9', url: 'https://hirealpha.chat/b/a9' })
  })

  it('reads the live payload copy when the local one is empty', () => {
    const live = [{ key: 'last_build_url', value: 'b2|https://hirealpha.chat/b/b2' }]
    expect(lastBuildFor(mem({}), live)).toEqual({ artifactId: 'b2', url: 'https://hirealpha.chat/b/b2' })
  })

  it('the newest mirror wins, and junk is ignored', () => {
    const facts = [
      { key: 'last_build_url', value: 'old|https://hirealpha.chat/b/old' },
      { key: 'last_build_url', value: 'new|https://hirealpha.chat/b/new' },
      { key: 'seat_preference', value: 'window seat' },
    ]
    expect(lastBuildFor(mem({ facts }))?.artifactId).toBe('new')
    expect(lastBuildFor(mem({ facts: [{ key: 'last_build_url', value: 'no-separator' }] }))).toBeUndefined()
  })
})

describe('recordDeliveredBuild', () => {
  /* The write side, which is what the live check disproved the first time: the
   * workshop's turn wrote the mirror and the `build` capability — the path a
   * "make me a dice roller" takes — wrote nothing, so asking for the fact
   * returned "No, there's no saved fact called last_build_url." Both paths call
   * this now. */
  it('writes the thread reference and the durable fact in one call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-ref-'))
    recordDeliveredBuild(dir, '+15550001111', { artifactId: 'z1', url: 'https://hirealpha.chat/b/z1' })

    const mem = loadMemory(dir, '+15550001111')
    expect(mem.lastBuild).toEqual({ artifactId: 'z1', url: 'https://hirealpha.chat/b/z1' })
    expect(lastBuildFor(mem)?.artifactId).toBe('z1')

    // The container swap: the thread file is gone, the payload re-hydrates the
    // fact, and the reference still resolves.
    const rehydrated = {
      history: [],
      facts: [{ key: 'last_build_url', value: 'z1|https://hirealpha.chat/b/z1', ts: Date.now(), lastSeen: Date.now() }],
    } as ThreadMemory
    expect(lastBuildFor(rehydrated)).toEqual({ artifactId: 'z1', url: 'https://hirealpha.chat/b/z1' })
  })
})
