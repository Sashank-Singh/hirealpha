import { describe, expect, test } from 'bun:test'
import { hasExplicitSendIntent } from './toolLoop'

/** Draft-vs-send gate: the mi1 regression — a "get ready to send" ask issued a
 * real file send. Only an explicit send verb authorizes one. */
describe('explicit send intent', () => {
  test('prepare-asks do NOT authorize a send', () => {
    expect(hasExplicitSendIntent('get the series a deck ready to send to sam')).toBe(false)
    expect(hasExplicitSendIntent('draft an email to Dana about Friday')).toBe(false)
    expect(hasExplicitSendIntent('prepare the deck for sam')).toBe(false)
    expect(hasExplicitSendIntent('get the invoice ready')).toBe(false)
  })

  test('explicit send-asks do', () => {
    expect(hasExplicitSendIntent('send the deck to sam')).toBe(true)
    expect(hasExplicitSendIntent('forward the invoice to accounting@x.com')).toBe(true)
    expect(hasExplicitSendIntent('ship it to sarah')).toBe(true)
    expect(hasExplicitSendIntent('get it ready and then send it to sarah')).toBe(true)
    expect(hasExplicitSendIntent('email it to Dana')).toBe(true)
  })
})
