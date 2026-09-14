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
