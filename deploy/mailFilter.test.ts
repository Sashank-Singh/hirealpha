import { describe, expect, it } from 'bun:test'
import { isAutomatedSender, isAutomatedSubject } from './hire-api'

describe('junk draft filter', () => {
  it('flags automated senders', () => {
    expect(isAutomatedSender('do-not-reply@coderbyte.com')).toBe(true)
    expect(isAutomatedSender('no-reply@turing.com')).toBe(true)
    expect(isAutomatedSender('notifications@linkedin.com')).toBe(true)
    expect(isAutomatedSender('team@strawberry.me')).toBe(false) // real address, filtered by subject
    expect(isAutomatedSender('linda@company.com')).toBe(false)
  })

  it('flags machine-notification subjects — including the coach nag with a magic link', () => {
    expect(isAutomatedSubject('Unread message from Laura G. (PCC)')).toBe(true)
    expect(isAutomatedSubject('Re: Assessment submitted for Netic AI')).toBe(true)
    expect(isAutomatedSubject('Reminder to complete Turing Testing for LLM Trainer')).toBe(true)
    expect(isAutomatedSubject('quick question about the contract')).toBe(false)
  })
})
