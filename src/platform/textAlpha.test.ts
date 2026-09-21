import { beforeEach, describe, expect, it } from 'bun:test'
import { setupIsDone } from './setupGate'
import { ALPHA_LINE, alphaThreadHref } from './alphaLine'

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
  /* "make that return to iMessages, then open the contact that has sent the
   * message … open the Alpha's chat so they can continue from there." `sms:` is
   * what opens the Messages thread on both iPhone and Mac; there is no
   * imessage:// handler to call. */
  it('opens the Alpha thread with a message ready', () => {
    expect(alphaThreadHref()).toBe('sms:+14155951440&body=Hey%2C%20Alpha!')
    expect(alphaThreadHref()).toContain(ALPHA_LINE)
  })

  it('falls back to the Alpha line rather than an empty sms: link', () => {
    expect(alphaThreadHref('')).toBe(`sms:${ALPHA_LINE}&body=Hey%2C%20Alpha!`)
  })

  it('uses the same constant the workspace and the landing page use', () => {
    expect(ALPHA_LINE).toBe('+14155951440')
  })
})
