/**
 * Deterministic anti-bot / login-wall detection.
 *
 * The vision model is not a reliable CAPTCHA detector: it can burn 30 steps
 * clicking a "Verify you are human" checkbox it cannot solve, or worse, read
 * a challenge page and answer "done". Every challenge class that has ever
 * blocked a real run is matched here from the page URL, visible frame URLs,
 * title, and body text BEFORE the model is called; the session then pauses
 * for the user (live handoff) or fails with the exact signal.
 *
 * Pure functions: no browser or network access, so regressions are cheap to
 * test. The page scan lives in browserSession (detectPageChallenge).
 */

export type ChallengeKind = 'captcha' | 'verification' | 'login' | 'blocked'

export type ChallengeSignal = {
  kind: ChallengeKind
  /** Stable id for activity rows and messages, e.g. 'cloudflare-interstitial'. */
  signal: string
  /** The matched text/URL fragment (truncated) so failures name the evidence. */
  evidence: string
}

export type ChallengeInput = {
  url?: string
  title?: string
  text?: string
  /** URLs of VISIBLE frames only; hidden badge/loader frames never count. */
  frameUrls?: string[]
  hasPasswordField?: boolean
}

const MAX_EVIDENCE = 120

/**
 * Anti-bot widgets are identifiable by the frame they load. Deliberately
 * narrow: reCAPTCHA's badge controller (`aframe`, `api.js`, `size=invisible`
 * anchor) is present on healthy pages and must not pause a run.
 */
const CHALLENGE_URL_PATTERNS: ReadonlyArray<{ signal: string; kind: ChallengeKind; re: RegExp; exclude?: RegExp }> = [
  { signal: 'cloudflare-turnstile', kind: 'captcha', re: /challenges\.cloudflare\.com/i },
  { signal: 'cloudflare-challenge', kind: 'captcha', re: /\/cdn-cgi\/challenge-platform/i },
  // anchor/bframe = rendered reCAPTCHA widget. size=invisible is the badge
  // controller on otherwise healthy pages, so it is excluded.
  { signal: 'recaptcha-challenge', kind: 'captcha', re: /google\.com\/recaptcha\/api2\/(?:anchor|bframe)/i, exclude: /size=invisible/i },
  { signal: 'recaptcha-challenge', kind: 'captcha', re: /recaptcha\.net\/api2\/(?:anchor|bframe)/i, exclude: /size=invisible/i },
  { signal: 'hcaptcha-challenge', kind: 'captcha', re: /hcaptcha\.com\/(?:captcha|1\/)/i },
  { signal: 'arkose-challenge', kind: 'captcha', re: /arkoselabs\.com|funcaptcha\.com/i },
  { signal: 'datadome-challenge', kind: 'captcha', re: /captcha-delivery\.com|datadome\.co/i },
  { signal: 'perimeterx-challenge', kind: 'captcha', re: /perimeterx\.net|px-cdn\.net/i },
  { signal: 'geetest-challenge', kind: 'captcha', re: /geetest\.com/i },
  { signal: 'aws-waf-challenge', kind: 'captcha', re: /captcha\.awswaf\.com/i },
]

/** Challenge wording visible in the page or title. Order matters: captcha
 * phrasing wins over generic verification, which wins over blocked. */
const TEXT_PATTERNS: ReadonlyArray<{ signal: string; kind: ChallengeKind; re: RegExp }> = [
  { signal: 'cloudflare-interstitial', kind: 'captcha', re: /just a moment/i },
  { signal: 'cloudflare-interstitial', kind: 'captcha', re: /checking your browser before accessing/i },
  { signal: 'cloudflare-interstitial', kind: 'captcha', re: /checking if (?:the )?site connection is secure/i },
  { signal: 'cloudflare-interstitial', kind: 'captcha', re: /enable javascript and cookies to continue/i },
  { signal: 'human-verification', kind: 'captcha', re: /verify(?:ing| that)? you(?:'re| are| is)? (?:a )?human/i },
  { signal: 'human-verification', kind: 'captcha', re: /(?:confirm|prove) (?:that )?you(?:'re| are) (?:a )?human/i },
  { signal: 'human-verification', kind: 'captcha', re: /are you (?:a )?human/i },
  { signal: 'human-verification', kind: 'captcha', re: /i(?:'m| am) not a robot/i },
  { signal: 'human-verification', kind: 'captcha', re: /\bhuman verification\b/i },
  { signal: 'captcha', kind: 'captcha', re: /\bcaptcha\b/i },
  { signal: 'unusual-traffic', kind: 'captcha', re: /unusual traffic/i },
  { signal: 'automated-traffic', kind: 'captcha', re: /automated (?:queries|traffic|requests)/i },
  { signal: 'press-and-hold', kind: 'captcha', re: /press (?:and|&|&amp;) hold/i },
  { signal: 'security-check', kind: 'captcha', re: /(?:complete|solve) the (?:security )?check/i },
  { signal: 'device-verification', kind: 'verification', re: /device verification/i },
  { signal: 'identity-verification', kind: 'verification', re: /(?:verify|confirm) your identity/i },
  { signal: 'identity-verification', kind: 'verification', re: /\bidentity verification\b/i },
  { signal: 'two-factor', kind: 'verification', re: /two[- ]?(?:factor|step) (?:authentication|verification)/i },
  { signal: 'two-factor', kind: 'verification', re: /\b2fa\b/i },
  { signal: 'one-time-code', kind: 'verification', re: /(?:enter|input) the (?:verification|security|one[- ]?time) code/i },
  { signal: 'one-time-code', kind: 'verification', re: /(?:we|we've) (?:sent|emailed|texted|messaged) (?:you )?(?:a|the) .{0,30}\b(?:code|pin)\b/i },
  { signal: 'verification-required', kind: 'verification', re: /verification required/i },
  { signal: 'blocked', kind: 'blocked', re: /pardon our interruption/i },
  { signal: 'blocked', kind: 'blocked', re: /access to this page has been denied/i },
  { signal: 'blocked', kind: 'blocked', re: /(?:sorry, )?you have been blocked/i },
  { signal: 'blocked', kind: 'blocked', re: /your request (?:has been|was) blocked/i },
  { signal: 'blocked', kind: 'blocked', re: /attention required[\s\S]{0,60}cloudflare/i },
  { signal: 'blocked', kind: 'blocked', re: /error 10(?:15|20)/i },
  { signal: 'blocked', kind: 'blocked', re: /403 forbidden/i },
  { signal: 'blocked', kind: 'blocked', re: /the request could not be satisfied/i },
  { signal: 'blocked', kind: 'blocked', re: /request unsuccessful[\s\S]{0,40}(?:incapsula|imperva)/i },
]

/** A login wall needs BOTH a password field and wall wording (or a sign-in
 * title); "Sign in" links in a healthy nav are not a wall. */
const LOGIN_TEXT_PATTERNS: ReadonlyArray<{ signal: string; re: RegExp }> = [
  { signal: 'login-wall', re: /(?:sign|log) ?in to continue/i },
  { signal: 'login-wall', re: /(?:sign|log) ?in to proceed/i },
  { signal: 'login-wall', re: /please (?:sign|log) ?in/i },
  { signal: 'login-wall', re: /you (?:must|need to) (?:sign|log) ?in/i },
  { signal: 'login-wall', re: /(?:sign|log) ?in (?:is )?required/i },
  { signal: 'login-wall', re: /(?:login|signin) required/i },
  { signal: 'session-expired', re: /session (?:expired|timed out)/i },
  { signal: 'password-required', re: /enter your password/i },
]

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_EVIDENCE)
}

function firstMatch(
  haystack: string,
  patterns: ReadonlyArray<{ signal: string; kind?: ChallengeKind; re: RegExp }>,
  kind: ChallengeKind,
): ChallengeSignal | null {
  for (const pattern of patterns) {
    const match = haystack.match(pattern.re)
    if (match) return { kind: pattern.kind || kind, signal: pattern.signal, evidence: clean(match[0]) }
  }
  return null
}

/**
 * Returns the first challenge found, or null for a normal page. URL/frame
 * evidence is checked first (a challenge iframe is present even when its text
 * has not rendered yet), then page text, then login walls, then hard blocks.
 */
export function detectChallenge(input: ChallengeInput): ChallengeSignal | null {
  const urls = [input.url || '', ...(input.frameUrls || [])].filter(Boolean)
  for (const pattern of CHALLENGE_URL_PATTERNS) {
    for (const url of urls) {
      if (pattern.re.test(url) && !pattern.exclude?.test(url)) {
        return { kind: pattern.kind, signal: pattern.signal, evidence: clean(url) }
      }
    }
  }

  const text = `${input.title || ''}\n${input.text || ''}`
  if (text.trim()) {
    // Blocked pages only count once no solvable challenge is present: a
    // Cloudflare interstitial also carries "Attention Required!".
    const solvable = firstMatch(text, TEXT_PATTERNS.filter((p) => p.kind !== 'blocked'), 'captcha')
    if (solvable) return solvable
  }

  if (input.hasPasswordField) {
    const title = input.title || ''
    // A password field plus a sign-in title is a wall; a password field in a
    // checkout "create password" form has no such title.
    if (/(?:sign|log)[- ]?in\b|\blogin\b/i.test(title)) {
      return { kind: 'login', signal: 'login-wall', evidence: clean(title) }
    }
    const loginText = firstMatch(text, LOGIN_TEXT_PATTERNS, 'login')
    if (loginText) return loginText
  }

  if (text.trim()) {
    const blocked = firstMatch(text, TEXT_PATTERNS.filter((p) => p.kind === 'blocked'), 'blocked')
    if (blocked) return blocked
  }
  return null
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** User-facing handoff instruction: names the evidence and the Resume action. */
export function challengeHandoffMessage(signal: ChallengeSignal, url: string): string {
  const host = hostOf(url)
  switch (signal.kind) {
    case 'captcha':
      return `${host} is showing a human-verification challenge (${signal.signal}). Finish it in the live browser window, then press Resume — Alpha will pick up where it left off.`
    case 'verification':
      return `${host} needs identity or device verification (${signal.signal}). Complete it in the live browser window, then press Resume — Alpha will pick up where it left off.`
    case 'login':
      return `${host} is asking you to sign in before it continues (${signal.signal}). Sign in in the live browser window, then press Resume — Alpha will pick up where it left off.`
    default:
      return `${host} blocked automated access (${signal.signal}).`
  }
}

/** Failure text when a handoff cannot be offered or the wall never clears. */
export function challengeFailureMessage(signal: ChallengeSignal, url: string): string {
  const host = hostOf(url)
  switch (signal.kind) {
    case 'captcha':
      return `${host} is behind a human-verification challenge (${signal.signal}: ${signal.evidence}).`
    case 'verification':
      return `${host} requires identity or device verification (${signal.signal}: ${signal.evidence}).`
    case 'login':
      return `${host} requires a sign-in that was not available (${signal.signal}: ${signal.evidence}).`
    default:
      return `${host} blocked automated access (${signal.signal}: ${signal.evidence}).`
  }
}
