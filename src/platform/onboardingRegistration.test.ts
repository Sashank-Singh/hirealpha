import { beforeEach, describe, expect, it } from 'bun:test'
import { APP_ALIASES } from './miniAppCatalog'
import { signIn, signOut } from './roster'

function createMockStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  }
}

describe('onboarding routing and registration aliases', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = createMockStorage()
  })
  it('maps setup and onboarding aliases to menu', () => {
    expect(APP_ALIASES['setup']).toBe('menu')
    expect(APP_ALIASES['onboarding']).toBe('menu')
  })

  it('signOut clears setup flags and session state', () => {
    localStorage.setItem('ha_setup_done', 'friend')
    localStorage.setItem('ha_setup_done_test@example.com', 'friend')
    localStorage.setItem('ha_setup_step', 'you')

    signIn('test@example.com', '+14155551212', 'Test')
    expect(localStorage.getItem('hirealpha-session')).toBeTruthy()

    signOut()

    expect(localStorage.getItem('hirealpha-session')).toBeNull()
    expect(localStorage.getItem('ha_setup_done')).toBeNull()
    expect(localStorage.getItem('ha_setup_step')).toBeNull()
    expect(localStorage.getItem('ha_setup_done_test@example.com')).toBeNull()
  })
})

/* The one-shot Text Alpha screen belongs to the account that saw it. It was left
 * set across a sign-out, so the next account on the same phone went straight to
 * the dashboard and never saw the screen that hands them their own Alpha line —
 * the founder hit exactly that, 2026-09-21: "text Alpha button ddint appear after
 * connector just took me to the dashboard". */
it('clears the one-shot Text Alpha flag on sign out', () => {
  localStorage.setItem('ha_text_alpha_seen', '1')
  signIn('test@example.com', '+14155551212', 'Test')
  signOut()
  expect(localStorage.getItem('ha_text_alpha_seen')).toBeNull()
})
