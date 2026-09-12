import { describe, expect, it } from 'bun:test'
import { challengeFailureMessage, challengeHandoffMessage, detectChallenge } from './challengeDetection'

/* ============================================================================
 * Anti-bot detection: the run must hand off (or fail explicitly) instead of
 * spending the whole budget on a page no model can solve. These cases are the
 * walls that actually stopped live runs (Yelp device verification, Cloudflare,
 * Google traffic checks).
 * ========================================================================== */

describe('challenge frame detection', () => {
  it('detects Cloudflare interstitials and Turnstile frames', () => {
    expect(detectChallenge({ url: 'https://shop.example/', frameUrls: ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc'] }))
      .toMatchObject({ kind: 'captcha', signal: 'cloudflare-turnstile' })
    expect(detectChallenge({ url: 'https://shop.example/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1' }))
      .toMatchObject({ kind: 'captcha', signal: 'cloudflare-challenge' })
  })

  it('detects hCaptcha, reCAPTCHA widgets, DataDome, Arkose, GeeTest', () => {
    expect(detectChallenge({ url: 'https://x.com', frameUrls: ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'] }))
      .toMatchObject({ signal: 'hcaptcha-challenge' })
    expect(detectChallenge({ url: 'https://x.com', frameUrls: ['https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc&size=normal'] }))
      .toMatchObject({ signal: 'recaptcha-challenge' })
    expect(detectChallenge({ url: 'https://x.com', frameUrls: ['https://www.google.com/recaptcha/api2/bframe?hl=en&k=abc'] }))
      .toMatchObject({ signal: 'recaptcha-challenge' })
    expect(detectChallenge({ url: 'https://x.com', frameUrls: ['https://geo.captcha-delivery.com/captcha/?initialCid=abc'] }))
      .toMatchObject({ signal: 'datadome-challenge' })
    expect(detectChallenge({ url: 'https://x.com', frameUrls: ['https://game.arkoselabs.com/fc/gc/?pk=abc'] }))
      .toMatchObject({ signal: 'arkose-challenge' })
    expect(detectChallenge({ url: 'https://x.com', frameUrls: ['https://static.geetest.com/static/js/gt.0.5.0.js'] }))
      .toMatchObject({ signal: 'geetest-challenge' })
  })

  it('ignores the invisible reCAPTCHA badge that healthy pages carry', () => {
    expect(detectChallenge({
      url: 'https://shop.example/checkout',
      text: 'Order total $18.99',
      frameUrls: ['https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc&size=invisible&cb=xyz'],
    })).toBeNull()
  })
})

describe('challenge text detection', () => {
  it('detects Cloudflare "Just a moment" and connection checks', () => {
    expect(detectChallenge({ url: 'https://shop.example/', title: 'Just a moment...', text: 'Checking your browser before accessing shop.example.' }))
      .toMatchObject({ kind: 'captcha', signal: 'cloudflare-interstitial' })
    expect(detectChallenge({ text: 'Checking if the site connection is secure' }))
      .toMatchObject({ signal: 'cloudflare-interstitial' })
  })

  it('detects human-verification wording', () => {
    expect(detectChallenge({ text: 'Verify you are human by completing the action below.' }))
      .toMatchObject({ kind: 'captcha', signal: 'human-verification' })
    expect(detectChallenge({ text: "I'm not a robot" })).toMatchObject({ signal: 'human-verification' })
    expect(detectChallenge({ text: 'Are you a human?' })).toMatchObject({ signal: 'human-verification' })
    expect(detectChallenge({ text: 'Press & Hold to confirm you are a human' })).toMatchObject({ signal: 'human-verification' })
  })

  it('detects Yelp/Google-style device verification and traffic checks', () => {
    expect(detectChallenge({ url: 'https://www.yelp.com/search', text: 'Yelp is showing a device verification screen. Complete the verification to continue.' }))
      .toMatchObject({ kind: 'verification', signal: 'device-verification' })
    expect(detectChallenge({ text: 'Our systems have detected unusual traffic from your computer network.' }))
      .toMatchObject({ kind: 'captcha', signal: 'unusual-traffic' })
    expect(detectChallenge({ text: 'To continue, please verify you are human.' }))
      .toMatchObject({ signal: 'human-verification' })
  })

  it('detects identity checks and one-time codes as verification handoffs', () => {
    expect(detectChallenge({ text: 'For your security, please verify your identity to continue.' }))
      .toMatchObject({ kind: 'verification', signal: 'identity-verification' })
    expect(detectChallenge({ text: 'Enter the verification code we sent to your phone.' }))
      .toMatchObject({ kind: 'verification', signal: 'one-time-code' })
    expect(detectChallenge({ text: 'Two-factor authentication is required for this account.' }))
      .toMatchObject({ kind: 'verification', signal: 'two-factor' })
  })

  it('detects hard blocks with the exact signal, not as task success', () => {
    expect(detectChallenge({ text: 'Pardon Our Interruption... As you were browsing, something about your browser made us think you were a bot.' }))
      .toMatchObject({ kind: 'blocked', signal: 'blocked' })
    expect(detectChallenge({ text: 'Access to this page has been denied.' }))
      .toMatchObject({ kind: 'blocked' })
    expect(detectChallenge({ text: 'Sorry, you have been blocked. You are unable to access example.com' }))
      .toMatchObject({ kind: 'blocked' })
    expect(detectChallenge({ url: 'https://example.com/', title: '403 Forbidden' }))
      .toMatchObject({ kind: 'blocked' })
  })
})

describe('login walls', () => {
  it('requires both a password field and wall wording', () => {
    expect(detectChallenge({ title: 'Log in to Yelp', hasPasswordField: true })).toMatchObject({ kind: 'login' })
    expect(detectChallenge({ text: 'Please sign in to continue', hasPasswordField: true })).toMatchObject({ kind: 'login' })
    expect(detectChallenge({ text: 'You must log in to view this page', hasPasswordField: true })).toMatchObject({ kind: 'login' })
    expect(detectChallenge({ text: 'Session expired. Please sign in again.', hasPasswordField: true })).toMatchObject({ kind: 'login' })
  })

  it('does not flag healthy pages with a sign-in link or a password form', () => {
    expect(detectChallenge({ title: 'Book a table', text: 'Sign in for faster checkout. Create account.', hasPasswordField: false })).toBeNull()
    expect(detectChallenge({ title: 'Create account', text: 'Choose a password', hasPasswordField: true })).toBeNull()
    expect(detectChallenge({ title: 'Book a table', text: 'Order total $42.00. Free cancellation.', hasPasswordField: false })).toBeNull()
  })

  it('prefers a solvable challenge over a block notice on the same page', () => {
    expect(detectChallenge({
      title: 'Attention Required! | Cloudflare',
      text: 'Please verify you are a human. Attention Required! Cloudflare',
    })).toMatchObject({ kind: 'captcha', signal: 'human-verification' })
  })
})

describe('handoff and failure messages', () => {
  const signal = { kind: 'captcha' as const, signal: 'cloudflare-turnstile', evidence: 'challenges.cloudflare.com/...' }
  it('names the host, the evidence, and Resume', () => {
    const message = challengeHandoffMessage(signal, 'https://shop.example/checkout')
    expect(message).toContain('shop.example')
    expect(message).toContain('cloudflare-turnstile')
    expect(message).toContain('Resume')
  })
  it('failure message names the signal and evidence', () => {
    const message = challengeFailureMessage(signal, 'https://shop.example/checkout')
    expect(message).toContain('shop.example')
    expect(message).toContain('cloudflare-turnstile')
    expect(message).toContain('challenges.cloudflare.com')
  })
})
