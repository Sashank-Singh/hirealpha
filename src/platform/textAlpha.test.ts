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

  /* "makethe Text Alpha button have Hey, Alpha! if you cannot text first" —
   * founder, 2026-09-21. Greeting only in that state: a first message gets
   * written for them, a thread that already exists is opened clean. */
  it('writes the first message only when Alpha has not texted', () => {
    expect(alphaThreadHref(ALPHA_LINE, { greet: true })).toBe('sms:+14155951440&body=Hey%2C%20Alpha!')
    expect(alphaThreadHref(ALPHA_LINE, { greet: false })).toBe('sms:+14155951440')
    expect(alphaThreadHref(ALPHA_LINE, {})).toBe('sms:+14155951440')
    // The assigned line still wins when both are in play.
    expect(alphaThreadHref('+14155550137', { greet: true })).toBe('sms:+14155550137&body=Hey%2C%20Alpha!')
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

/* Checked live, 2026-09-21, after the number was removed from Photon:
 * `GET /api/assigned-phone?phone=+12163032166` → `{"assignedPhone":null}`. The
 * line is assigned asynchronously at signup, so a person who races through
 * onboarding can arrive at the screen before it exists — and the one thing that
 * screen must never do is show a house number as if it were theirs, which is the
 * "generic number" the founder objected to. */
describe('no assigned line yet', () => {
  it('never renders a number the screen cannot confirm', async () => {
    const { readFileSync } = await import('node:fs')
    const page = readFileSync(new URL('./TextAlphaPage.tsx', import.meta.url), 'utf8')
    // A null line opens Messages itself rather than a number, and the number
    // line under the button only renders when there is one.
    expect(page).toContain("href={line ? alphaThreadHref(line, { greet: welcome !== 'sent' }) : 'sms:'}")
    expect(page).toContain('{line && <p className="textalpha__line">{formatAlphaLine(line)}</p>}')
    expect(page).not.toContain('ALPHA_LINE')
  })
})
