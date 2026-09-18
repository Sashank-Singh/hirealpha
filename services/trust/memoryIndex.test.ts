import { describe, expect, it } from 'bun:test'
import {
  NullMemoryIndex,
  createMemoryIndex,
  isVectorMissingError,
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

describe('pgvector-missing degradation', () => {
  const base = {
    connectionString: 'postgresql://memory.test/hirealpha',
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'test-embed',
    dimensions: 8,
  }

  it('recognizes only the pgvector-unavailable errors', () => {
    expect(isVectorMissingError(new Error('extension "vector" is not available'))).toBe(true)
    expect(isVectorMissingError(new Error('type "vector" does not exist'))).toBe(true)
    expect(isVectorMissingError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(false)
    expect(isVectorMissingError(new Error('search timed out'))).toBe(false)
    expect(isVectorMissingError(new Error('caused', { cause: new Error('extension "vector" is not available') }))).toBe(true)
  })

  it('latches the index off after the extension is confirmed missing', async () => {
    let attempts = 0
    const index = createMemoryIndex({
      ...base,
      createBackend: async () => {
        attempts += 1
        throw new Error('extension "vector" is not available')
      },
    })

    expect(await index.search({ userId: 'u', persona: 'friend', query: 'seat', k: 5 })).toEqual([])
    expect(attempts).toBe(1)
    // Second call must not touch the backend again — no repeated error spam.
    expect(await index.search({ userId: 'u', persona: 'friend', query: 'seat', k: 5 })).toEqual([])
    expect(await index.index({ id: 'm1', userId: 'u', persona: 'friend', key: 'diet', text: 'diet: no pork' })).toBe(false)
    expect(await index.removeKeys({ userId: 'u', persona: 'friend', keys: ['diet'] })).toBe(0)
    expect(await index.dropByUser('u')).toBe(0)
    expect(attempts).toBe(1)
  })

  it('latches when the backend constructs but its operations report the missing extension', async () => {
    let attempts = 0
    const index = createMemoryIndex({
      ...base,
      createBackend: async () => {
        attempts += 1
        return {
          add: async () => undefined,
          search: async () => {
            throw new Error('type "vector" does not exist')
          },
          getAll: async () => ({ results: [] }),
          delete: async () => undefined,
          deleteAll: async () => ({}),
        }
      },
    })
    expect(await index.search({ userId: 'u', persona: 'friend', query: 'x', k: 5 })).toEqual([])
    expect(await index.search({ userId: 'u', persona: 'friend', query: 'x', k: 5 })).toEqual([])
    expect(attempts).toBe(1)
  })

  it('does not latch on a transient connection failure', async () => {
    let attempts = 0
    const index = createMemoryIndex({
      ...base,
      createBackend: async () => {
        attempts += 1
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
      },
    })
    await index.search({ userId: 'u', persona: 'friend', query: 'x', k: 5 })
    await index.search({ userId: 'u', persona: 'friend', query: 'x', k: 5 })
    expect(attempts).toBe(2)
  })
})
