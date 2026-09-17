import { describe, expect, test } from 'bun:test'
import { SwipeGesture, SWIPE_DEFAULTS, swipeBackTarget } from './swipeBack'

/** A gesture that starts at 0,0 at t=0 and ends wherever it ends. */
function swipe(x: number, y: number, ms: number) {
  const g = new SwipeGesture()
  g.start(0, 0, 0)
  g.move(x, y)
  const progress = g.progress
  return { g, progress, commit: g.end(ms) }
}

describe('swipe-back gesture', () => {
  test('a right drag past the commit distance goes back', () => {
    const { progress, commit } = swipe(SWIPE_DEFAULTS.commitPx + 4, 6, 500)
    expect(progress).toBe(1)
    expect(commit).toBe(true)
  })

  test('a short right drag does not', () => {
    expect(swipe(SWIPE_DEFAULTS.commitPx - 20, 2, 500).commit).toBe(false)
  })

  test('a quick flick commits under the full distance', () => {
    expect(swipe(SWIPE_DEFAULTS.flickPx + 2, 4, 120).commit).toBe(true)
  })

  test('the same short drag held slow does not', () => {
    expect(swipe(SWIPE_DEFAULTS.flickPx + 2, 4, 900).commit).toBe(false)
  })

  test('a vertical scroll is never a back swipe', () => {
    const g = new SwipeGesture()
    g.start(0, 0, 0)
    expect(g.move(6, 40)).toBe('cancelled')
    expect(g.move(10, 160)).toBe('cancelled')
    expect(g.end(700)).toBe(false)
  })

  test('a leftward swipe belongs to somebody else', () => {
    const g = new SwipeGesture()
    g.start(200, 0, 0)
    expect(g.move(140, 2)).toBe('cancelled')
    expect(g.end(300)).toBe(false)
  })

  test('tiny jitter stays undecided until the finger picks a direction', () => {
    const g = new SwipeGesture()
    g.start(0, 0, 0)
    expect(g.move(3, 4)).toBe('undecided')
    expect(g.progress).toBe(0)
    expect(g.move(90, 8)).toBe('horizontal')
    expect(g.end(400)).toBe(true)
  })

  test('a drag that dives into a scroll loses the gesture', () => {
    const g = new SwipeGesture()
    g.start(0, 0, 0)
    expect(g.move(40, 4)).toBe('horizontal')
    expect(g.move(48, 220)).toBe('cancelled')
    expect(g.end(600)).toBe(false)
  })

  test('the pull follows the finger back in, and can still commit', () => {
    const g = new SwipeGesture()
    g.start(0, 0, 0)
    expect(g.move(150, 4)).toBe('horizontal')
    expect(g.progress).toBe(1)
    expect(g.move(120, 5)).toBe('horizontal')
    expect(g.progress).toBe(1)
    expect(g.move(20, 5)).toBe('horizontal')
    expect(g.progress).toBeCloseTo(20 / SWIPE_DEFAULTS.commitPx, 5)
    expect(g.end(500)).toBe(false)
  })

  test('dragging back across the start cancels, however far it had pulled', () => {
    const g = new SwipeGesture()
    g.start(0, 0, 0)
    expect(g.move(150, 4)).toBe('horizontal')
    expect(g.move(-6, 5)).toBe('cancelled')
    expect(g.end(500)).toBe(false)
  })

  test('progress tracks the pull and clamps at both ends', () => {
    const g = new SwipeGesture()
    g.start(0, 0, 0)
    g.move(18, 0)
    expect(g.progress).toBeCloseTo(18 / SWIPE_DEFAULTS.commitPx, 5)
    expect(g.move(400, 0)).toBe('horizontal')
    expect(g.progress).toBe(1)
  })

  test('a cancelled gesture stays cancelled until the finger lifts', () => {
    const g = new SwipeGesture()
    g.start(0, 0, 0)
    g.move(4, 60)
    expect(g.move(200, 62)).toBe('cancelled')
    expect(g.end(500)).toBe(false)
  })

  test('cancel() retires a gesture that ended elsewhere', () => {
    const g = new SwipeGesture()
    g.start(0, 0, 0)
    g.move(200, 4)
    g.cancel()
    expect(g.isHorizontal).toBe(false)
    expect(g.end(400)).toBe(false)
    expect(g.progress).toBe(0)
  })
})

describe('where the swipe lands', () => {
  const base = { mailOpen: false, sheetOpen: false, historyIdx: 0, homeHref: '/app/mini/friend/apps' }

  test('an open email sheet closes first', () => {
    expect(swipeBackTarget({ ...base, mailOpen: true, sheetOpen: true, historyIdx: 3 })).toEqual({ kind: 'mail' })
  })

  test('settings closes next', () => {
    expect(swipeBackTarget({ ...base, sheetOpen: true, historyIdx: 3 })).toEqual({ kind: 'sheet' })
  })

  test('on a page with history it returns to the screen before it', () => {
    expect(swipeBackTarget({ ...base, historyIdx: 1 })).toEqual({ kind: 'history' })
  })

  test('a card opened straight from a text falls back to home', () => {
    expect(swipeBackTarget(base)).toEqual({ kind: 'home', href: '/app/mini/friend/apps' })
  })
})
