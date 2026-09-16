import { describe, expect, it } from 'bun:test'
import { buildBrowserUseCredentialConfig } from './browserUseSession'
import { readFileSync } from 'node:fs'

describe('Browser Use credential configuration', () => {
  it('marks a complete Vault login and scopes it to the target origin', () => {
    expect(buildBrowserUseCredentialConfig({
      url: 'https://campusnet.csuohio.edu/ps8verify.jsp',
      username: 'student-id',
      password: 'secret',
    })).toEqual({
      state: 'complete',
      username: 'student-id',
      password: 'secret',
      origin: 'https://campusnet.csuohio.edu',
    })
  })

  it('never represents a password-only Vault entry as usable credentials', () => {
    expect(buildBrowserUseCredentialConfig({
      url: 'https://campusnet.csuohio.edu/login',
      username: '   ',
      password: 'secret',
    }).state).toBe('partial')
  })

  it('marks an empty Vault lookup as missing', () => {
    expect(buildBrowserUseCredentialConfig({
      url: 'https://example.com',
      username: '',
      password: '',
    }).state).toBe('missing')
  })
})

describe('Browser Use login recovery policy', () => {
  const runner = readFileSync(new URL('./browserUseRunner.py', import.meta.url), 'utf8')

  it('requires populated username and password fields before submitting', () => {
    expect(runner).toContain('never click Login with either field empty')
  })

  it('retries a failed Vault login at most three times before handoff', () => {
    expect(runner).toContain('Make at most three login submissions total')
    expect(runner).toContain('After the third failure, call request_user_handoff')
  })

  it('gives a slow browser model enough time to return a step', () => {
    expect(runner).toContain('llm_timeout=120')
  })
})
