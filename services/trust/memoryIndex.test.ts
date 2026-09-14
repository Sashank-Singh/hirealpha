import { describe, expect, it } from 'bun:test'
import {
  NullMemoryIndex,
  memoryIndexFromEnv,
  memoryIndexStatusFromEnv,
} from './memoryIndex'

describe('standard Mem0 configuration', () => {
  it('uses Mem0 by default when the application database is configured', () => {
    const env = { DATABASE_URL: 'postgresql://memory.test/hirealpha' }
    expect(memoryIndexStatusFromEnv(env)).toEqual({ provider: 'mem0', enabled: true })
    expect(memoryIndexFromEnv(env)).not.toBeInstanceOf(NullMemoryIndex)
  })

  it('supports an explicit emergency disable', () => {
    const env = { DATABASE_URL: 'postgresql://memory.test/hirealpha', MEM0_ENABLED: 'false' }
    expect(memoryIndexStatusFromEnv(env)).toEqual({ provider: 'mem0', enabled: false })
    expect(memoryIndexFromEnv(env)).toBeInstanceOf(NullMemoryIndex)
  })

  it('does not report Mem0 ready without a database', () => {
    expect(memoryIndexStatusFromEnv({})).toEqual({ provider: 'mem0', enabled: false })
  })
})
