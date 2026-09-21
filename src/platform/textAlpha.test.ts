import { beforeEach, describe, expect, it } from 'bun:test'
import { setupIsDone } from './setupGate'
import { ALPHA_LINE, alphaThreadHref, formatAlphaLine } from './alphaLine'

function createMockStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  }
}

describe('the post-onboarding gate', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = createMockStorage()
  })

  /* Live, 2026-09-20: connecting Gmail on the wizard's last page returned to the
   * menu URL and the gate read the server's auto-detect as "setup done", so the
   * founder landed on the mini-app home grid instead of the connect page he had
   * just left. Founder, verbatim: "I connected Gmail and it took me to this page,
   * which is the homepage of miniapps. It should not do that." */
  it('keeps a wizard in flight open even when the server says done', () => {
    expect(setupIsDone({ localDone: null, stepInFlight: 'connect', serverDone: true })).toBe(false)
    expect(setupIsDone({ localDone: null, stepInFlight: 'you', serverDone: true })).toBe(false)
  })

  it('never reopens a finished wizard', () => {
    expect(setupIsDone({ localDone: 'friend', stepInFlight: null, serverDone: false })).toBe(true)
    // A stale step key left behind on another device must not beat the mirror.
    expect(setupIsDone({ localDone: 'friend', stepInFlight: 'connect', serverDone: false })).toBe(true)
  })

  it('asks the server when nothing local decides', () => {
    expect(setupIsDone({ localDone: null, stepInFlight: null, serverDone: null })).toBeNull()
    expect(setupIsDone({ localDone: null, stepInFlight: null, serverDone: true })).toBe(true)
    expect(setupIsDone({ localDone: null, stepInFlight: null, serverDone: false })).toBe(false)
  })

  it('does not treat another persona flag as this one', () => {
    expect(setupIsDone({ localDone: 'coworker', stepInFlight: null, serverDone: null })).toBeNull()
  })
})

describe('the one link on the Text Alpha screen', () => {
  /* "just takes to the thread not start a new message — takes to iMessage thread
   * with Alpha since it already texted me first during onboarding." A prefilled
   * draft IS the new-message look: verified on macOS, `sms:<line>&body=…` opens
   * the thread with "Hey, Alpha!" typed in, `sms:<line>` opens it empty. */
  it('opens the Alpha thread, with nothing typed into the composer', () => {
    expect(alphaThreadHref()).toBe('sms:+14155951440')
    expect(alphaThreadHref()).toContain(ALPHA_LINE)
    expect(alphaThreadHref()).not.toContain('body=')
  })

  it('falls back to the Alpha line rather than an empty sms: link', () => {
    expect(alphaThreadHref('')).toBe(`sms:${ALPHA_LINE}`)
  })

  it('uses the same constant the workspace and the landing page use', () => {
    expect(ALPHA_LINE).toBe('+14155951440')
  })

  /* "alpha number is always diffrent for users so it needs to make sure about the
   * number from photon and show that number not just a generic number its
   * different for every user" — founder, 2026-09-21. The href must carry whatever
   * line the account was assigned, and the screen shows it in the phone format
   * people recognise their sender by. */
  it('carries the assigned line, and shows it the way a phone does', () => {
    const assigned = '+14155550137'
    expect(alphaThreadHref(assigned)).toBe(`sms:${assigned}`)
    expect(alphaThreadHref(assigned)).not.toContain('14155951440')
    expect(formatAlphaLine(assigned)).toBe('(415) 555-0137')
    expect(formatAlphaLine(ALPHA_LINE)).toBe('(415) 595-1440')
    // Anything that is not a 10/11-digit US number is passed through untouched
    // rather than mangled into a wrong-looking one.
    expect(formatAlphaLine('+442071838750')).toBe('+442071838750')
  })
})
