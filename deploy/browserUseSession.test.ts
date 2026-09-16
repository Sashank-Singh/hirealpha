import { describe, expect, it } from 'bun:test'
import { buildBrowserUseCredentialConfig } from './browserUseSession'

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
