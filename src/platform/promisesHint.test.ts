import { describe, expect, test } from 'bun:test'
import { promisesHubHint } from './promisesHint'

describe('promisesHubHint', () => {
  test('explains the empty list', () => {
    expect(promisesHubHint([], '2026-08-21')).toBe('Catch what you told someone you would do')
  })

  test('shows the next owed thing', () => {
    expect(
      promisesHubHint([{ title: 'Send Amy the intro', dueAt: '2026-08-21T12:00:00.000Z' }], '2026-08-21'),
    ).toBe('Send Amy the intro  due today')
  })

  test('counts the rest', () => {
    const hint = promisesHubHint(
      [
        { title: 'Send Amy the intro', dueAt: '2026-08-21' },
        { title: 'Reply to Luigi', dueAt: '2026-08-22' },
      ],
      '2026-08-21',
    )
    expect(hint).toBe('Send Amy the intro  and 1 more')
  })
})
