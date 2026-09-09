import { expect, it } from 'bun:test'
import { createMessageBursts } from './messageBursts'

function fixture(run?: (items: string[]) => Promise<void>) {
  let time = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const batches: string[][] = []
  const errors: unknown[] = []
  const queue = createMessageBursts<string>({
    now: () => time,
    schedule: (fn, ms) => { timers.set(++id, { at: time + ms, fn }); return id },
    cancel: token => { timers.delete(token as number) },
    run: async items => { batches.push(items); await run?.(items) },
    onError: error => { errors.push(error) },
  })
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  return { queue, batches, errors, settle, advance: async (ms: number) => {
    const end = time + ms
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      time = next[1].at
      timers.delete(next[0]); next[1].fn()
      await settle()
    }
    time = end
    await settle()
  } }
}

it('combines four restaurant and ride fragments into one ordered turn', async () => {
  const f = fixture()
  for (const text of ['Hey I want to', 'go to a Chinese restaurant', 'at 8 pm nearby', 'and tell me how much is the Uber']) {
    f.queue.enqueue('alice', text)
    await f.advance(300)
  }
  expect(f.batches).toEqual([])
  await f.advance(650)
  expect(f.batches).toEqual([['Hey I want to', 'go to a Chinese restaurant', 'at 8 pm nearby', 'and tell me how much is the Uber']])
})

it('starts a single message after the quiet window and caps a continuous burst', async () => {
  const f = fixture()
  f.queue.enqueue('alice', 'one message')
  await f.advance(650)
  expect(f.batches).toEqual([['one message']])
  for (let i = 0; i < 6; i++) { f.queue.enqueue('alice', String(i)); await f.advance(400) }
  await f.advance(100)
  expect(f.batches[1]).toEqual(['0', '1', '2', '3', '4', '5'])
})

it('serializes one sender while letting another sender proceed', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const f = fixture(async items => { if (items[0] === 'first') await blocked })
  f.queue.enqueue('alice', 'first')
  await f.advance(650)
  f.queue.enqueue('alice', 'follow-up')
  f.queue.enqueue('alice', 'more details')
  f.queue.enqueue('bob', 'hello')
  await f.advance(700)
  expect(f.batches).toEqual([['first'], ['hello']])
  release(); await f.settle()
  expect(f.batches).toEqual([['first'], ['hello'], ['follow-up', 'more details']])
})

it('preserves media boundaries and recovers after a failed turn without retrying it', async () => {
  const f = fixture(async items => { if (items[0] === 'text') throw new Error('failed') })
  f.queue.enqueue('alice', 'text')
  f.queue.enqueue('alice', 'photo', false)
  f.queue.enqueue('alice', 'caption follow-up')
  await f.advance(650)
  expect(f.batches).toEqual([['text'], ['photo'], ['caption follow-up']])
  expect(f.errors).toHaveLength(1)
})
