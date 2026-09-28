import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { teachLine, recordTeach, TEACH_LINES } from './teaches'
import { loadMemory } from './memory'

const dataDir = mkdtempSync(join(tmpdir(), 'teach-'))
const sender = '+15550001111'

describe('contextual teaches — gated, not nagging', () => {
  it('shows a teach the first time, at most twice, with a cooldown', () => {
    const mem = () => loadMemory(dataDir, sender)
    const now = Date.now()
    expect(teachLine('price_watch', mem(), now)).toBe(TEACH_LINES.price_watch)
    recordTeach('price_watch', dataDir, sender, mem(), now)
    // Within the cooldown: silent even though the count allows one more.
    expect(teachLine('price_watch', mem(), now + 1000)).toBeNull()
    // After the cooldown the second (and final) show is allowed.
    expect(teachLine('price_watch', mem(), now + 4 * 24 * 60 * 60 * 1000)).toBe(TEACH_LINES.price_watch)
    recordTeach('price_watch', dataDir, sender, mem(), now + 4 * 24 * 60 * 60 * 1000)
    expect(teachLine('price_watch', mem(), now + 9 * 24 * 60 * 60 * 1000)).toBeNull()
  })

  it('teaches are per-capability, so a follow-up teach still fires', () => {
    const mem = () => loadMemory(dataDir, sender)
    expect(teachLine('followup_watch', mem(), Date.now())).toBe(TEACH_LINES.followup_watch)
  })
})
