import { expect, it } from 'bun:test'
import { createProgressiveDelivery, createReactionGate } from './progressiveDelivery'

it('keeps fast tasks quiet and bounds intermediate texts without repeats', async () => {
  let time = 0
  const sent: string[] = []
  const delivery = createProgressiveDelivery({ onProgress: async text => { sent.push(text) } }, { now: () => time })
  expect(await delivery.publish('Partial result')).toBe(false)
  time = 2500
  expect(await delivery.publish('Partial result')).toBe(true)
  expect(await delivery.publish('Another result')).toBe(false)
  time = 4100
  expect(await delivery.publish('Partial result')).toBe(false)
  expect(await delivery.publish('Another result')).toBe(true)
  time = 6000
  expect(await delivery.publish('Too many texts')).toBe(false)
  expect(sent).toEqual(['Partial result', 'Another result'])
})

it('does not retry uncertain sends or let them fail the task', async () => {
  let attempts = 0
  const delivery = createProgressiveDelivery({ onProgress: async () => { attempts++; throw new Error('ambiguous') } }, { quietMs: 0 })
  expect(await delivery.publish('Result')).toBe(false)
  expect(await delivery.publish('Result')).toBe(false)
  expect(delivery.delivered).toEqual([])
  expect(attempts).toBe(1)
  expect(await delivery.stage('Working', async () => 'finished')).toBe('finished')
})

it('only acknowledges a slow stage, and clears its timer on a quick success or failure', async () => {
  const sent: string[] = []
  const delivery = createProgressiveDelivery({ onProgress: async text => { sent.push(text) } }, { quietMs: 10 })
  await delivery.stage('Do not send', async () => 'quick')
  await expect(delivery.stage('Do not send either', async () => { throw new Error('failed') })).rejects.toThrow('failed')
  await new Promise(resolve => setTimeout(resolve, 15))
  expect(sent).toEqual([])
  await delivery.stage('Checking nearby options', async () => { await new Promise(resolve => setTimeout(resolve, 15)) })
  expect(sent).toEqual(['Checking nearby options'])
  await delivery.stage('No second acknowledgement', async () => { await new Promise(resolve => setTimeout(resolve, 15)) })
  expect(sent).toHaveLength(1)
})

it('limits reactions per conversation, isolates users, and tolerates delivery failure', async () => {
  let time = 0
  const gate = createReactionGate(() => time)
  const reactions: string[] = []
  const send = async (emoji: string) => { reactions.push(emoji) }
  await gate('a', '🎉', send)
  await gate('a', '👍', send)
  await gate('b', '❤️', send)
  expect(reactions).toEqual(['🎉', '❤️'])
  time = 180001
  await gate('a', '😂', send)
  await gate('c', '👀', async () => { throw new Error('not supported') })
  expect(reactions).toEqual(['🎉', '❤️', '😂'])
})
