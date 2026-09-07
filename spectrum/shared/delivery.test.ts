import { expect, it } from 'bun:test'
import { onceAsync } from './delivery'

it('reuses one turn across concurrent calls and a delivery retry', async () => {
  let executions = 0
  const getTurn = onceAsync(async () => { executions++; return { reply: 'Sent.' } })
  const [first, second] = await Promise.all([getTurn(), getTurn()])
  expect(await getTurn()).toBe(first)
  expect(second).toBe(first)
  expect(executions).toBe(1)
})

it('does not replay potentially completed side effects after an ambiguous turn failure', async () => {
  let executions = 0
  const getTurn = onceAsync(async () => { executions++; throw new Error('failed after write') })
  await expect(getTurn()).rejects.toThrow('failed after write')
  await expect(getTurn()).rejects.toThrow('failed after write')
  expect(executions).toBe(1)
})
