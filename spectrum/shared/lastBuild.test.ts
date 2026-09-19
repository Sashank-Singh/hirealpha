import { describe, expect, it } from 'bun:test'
import { lastBuildFor } from './runHireTurn'
import type { ThreadMemory } from './memory'

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
