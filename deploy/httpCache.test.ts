import { describe, expect, test } from 'bun:test'
import { notModified, revalidateCacheControl, weakEtag } from './httpCache'

describe('weakEtag', () => {
  test('is stable for the same body and different for a changed one', () => {
    const a = weakEtag(JSON.stringify({ n: 1, mail: ['Amy'] }))
    expect(weakEtag(JSON.stringify({ n: 1, mail: ['Amy'] }))).toBe(a)
    expect(weakEtag(JSON.stringify({ n: 1, mail: ['Bob'] }))).not.toBe(a)
  })

  test('is a quoted weak validator', () => {
    expect(weakEtag('{}')).toMatch(/^W\/"[a-z0-9]+"$/)
  })
})

describe('revalidateCacheControl', () => {
  test('allows a stale paint when given a window', () => {
    expect(revalidateCacheControl(60)).toBe('private, max-age=0, stale-while-revalidate=60')
  })

  test('refuses to serve stale when the answer is incomplete', () => {
    expect(revalidateCacheControl(0)).toBe('private, no-cache')
    expect(revalidateCacheControl(-5)).toBe('private, no-cache')
    expect(revalidateCacheControl(Number.NaN)).toBe('private, no-cache')
  })

  test('never emits a fractional second', () => {
    expect(revalidateCacheControl(1.9)).toBe('private, max-age=0, stale-while-revalidate=1')
  })

  test('is always private — the payload is one person’s inbox and calendar', () => {
    expect(revalidateCacheControl(60).startsWith('private')).toBe(true)
    expect(revalidateCacheControl(0).startsWith('private')).toBe(true)
  })
})

describe('notModified', () => {
  const etag = weakEtag('{"a":1}')

  test('matches the tag we sent', () => {
    expect(notModified(etag, etag)).toBe(true)
  })

  test('matches inside a list and ignores the weak prefix', () => {
    expect(notModified(`W/"zzz", ${etag}`, etag)).toBe(true)
    expect(notModified(etag.replace('W/', ''), etag)).toBe(true)
    expect(notModified(etag, etag.replace('W/', ''))).toBe(true)
  })

  test('honours a wildcard', () => {
    expect(notModified('*', etag)).toBe(true)
  })

  test('does not match a different tag, empty, or a missing header', () => {
    expect(notModified('W/"nope"', etag)).toBe(false)
    expect(notModified(null, etag)).toBe(false)
    expect(notModified(undefined, etag)).toBe(false)
    expect(notModified('', etag)).toBe(false)
    expect(notModified(etag, '')).toBe(false)
  })
})
