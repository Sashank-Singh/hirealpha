import { loadMemory, removeFacts, upsertFacts } from './memory'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('a deletion on the server reaches the local store', () => {
  /* A memory removed in the dashboard used to keep being injected from the
   * container-local file until the container was recreated, because nothing
   * carried the deletion back. */
  it('drops only the deleted keys, and reports them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-del-'))
    try {
      const phone = '+15550001111'
      upsertFacts(dir, phone, [
        { key: 'seat_preference', value: 'aisle', ts: Date.now(), lastSeen: Date.now() },
        { key: 'hard_nos', value: 'no pork', ts: Date.now(), lastSeen: Date.now() },
      ])
      expect(removeFacts(dir, phone, ['seat_preference'])).toEqual(['seat_preference'])
      const left = loadMemory(dir, phone).facts.map((f) => f.key)
      expect(left).toEqual(['hard_nos'])
      // Idempotent: deleting again removes nothing and reports nothing.
      expect(removeFacts(dir, phone, ['seat_preference'])).toEqual([])
      expect(removeFacts(dir, phone, [])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
