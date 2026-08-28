import { describe, expect, it } from 'bun:test'
import { workshopPhoneGate } from './liveContext'

/* The first real build shipped arrow-key paddles to an iPhone: keyboard-only
 * code for a game ask. The gate is what turns that into a repair pass instead
 * of a dead artifact. */

const KEYBOARD_PONG = `
  document.addEventListener('keydown', (e) => { keys[e.key] = true })
  document.addEventListener('keyup', (e) => { keys[e.key] = false })
  if (keys['ArrowUp']) p1Y -= 6
`

const TOUCH_PONG = `
  startBtn.addEventListener('click', start)
  canvas.addEventListener('touchmove', (e) => { p1Y = e.touches[0].clientY })
  document.addEventListener('pointerdown', movePaddle)
`

describe('workshopPhoneGate', () => {
  it('flags a keyboard-only game built from a game ask', () => {
    expect(workshopPhoneGate('build a ping pong game minimal ui', KEYBOARD_PONG)).toContain('touch')
  })

  it('passes touch-driven code even for a game ask', () => {
    expect(workshopPhoneGate('build a ping pong game', TOUCH_PONG)).toBeNull()
  })

  it('passes keyboard-plus-touch: keyboard is a desktop bonus', () => {
    expect(workshopPhoneGate('build a snake game', KEYBOARD_PONG + TOUCH_PONG)).toBeNull()
  })

  it('passes interactive code with no input handlers at all (static showpieces)', () => {
    expect(workshopPhoneGate('build a sudoku game', '<h1>Sudoku</h1><p>coming soon</p>')).toBeNull()
  })

  it('ignores non-interactive asks entirely', () => {
    expect(workshopPhoneGate('build a mileage tracker', KEYBOARD_PONG)).toBeNull()
  })

  it('catches varied interactive asks: quiz, piano, clicker', () => {
    for (const ask of ['a trivia quiz app', 'a piano', 'an energy clicker game']) {
      expect(workshopPhoneGate(ask, KEYBOARD_PONG)).toContain('touch')
    }
  })
})
