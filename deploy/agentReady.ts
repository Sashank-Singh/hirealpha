/**
 * Agent-readiness helpers for the public web server.
 *
 * Kept pure (no I/O) so the routing/negotiation decisions are unit-testable:
 * real 404s for unknown paths, `Accept: text/markdown` content negotiation,
 * and the markdown bodies that back both. See acceptmarkdown.com and llmstxt.org.
 */

export const SITE_URL = 'https://hirealpha.chat'

/**
 * Client routes the SPA actually owns. Everything else that is not a static
 * asset, a machine file, or a known page is a genuine 404 — serving the app
 * shell with a 200 for any path made agents believe every URL exists.
 */
export function isKnownClientRoute(pathname: string): boolean {
  if (pathname === '/') return true
  return pathname === '/app' || pathname.startsWith('/app/')
}

/** Clean URL → static HTML file (relative to the dist root). */
export const PAGE_FILES: Record<string, string> = {
  '/about': 'pages/about.html',
  '/contact': 'pages/contact.html',
  '/privacy': 'pages/privacy.html',
  '/developers': 'pages/developers.html',
  '/docs': 'pages/docs.html',
}

export function isKnownPage(pathname: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAGE_FILES, pathname)
}

/** True when the client explicitly asked for markdown. */
export function wantsMarkdown(accept: string | null): boolean {
  if (!accept) return false
  return /text\/markdown|text\/x-markdown|\bmarkdown\b/i.test(accept)
}

const HOME_MD = `# HireAlpha — hire Friend, Coworker, and Cofounder in iMessage

HireAlpha puts three separate AI personas in your real message threads. Friend keeps
your life on track (sleep, food, training, spending, people you owe a reply). Coworker
runs your workday (next action, meeting prep, drafts, Linear triage). Cofounder thinks
about the company (pipeline, runway, decisions, investor notes). Each has its own number,
memory, and personality. $19 per persona per month.

- About: ${SITE_URL}/about
- Contact: ${SITE_URL}/contact
- Privacy: ${SITE_URL}/privacy
- Developers: ${SITE_URL}/developers
- OpenAPI: ${SITE_URL}/openapi.json
- llms.txt: ${SITE_URL}/llms.txt
`

const PAGE_MD: Record<string, string> = {
  '/about': `# About HireAlpha

HireAlpha is a small product with a simple thesis: the best place for an AI assistant is
the message thread you already live in. Friend handles your personal life, Coworker your
workday, Cofounder your company. Each is its own contact with its own memory and tone.
$19 per persona per month. Made by a small independent team in San Francisco.
`,
  '/contact': `# Contact HireAlpha

Support: hello@hirealpha.chat (one business day). Press: press@hirealpha.chat.
Partnerships: partners@hirealpha.chat. Based in San Francisco, CA, USA.
`,
  '/privacy': `# Privacy at HireAlpha

We do not sell your data, advertise against it, or train shared models on it. Your personas
read only the Google data you connect and the things you log or text them. Deleting your
account deletes your rows within 30 days. Email hello@hirealpha.chat for a copy or deletion.
`,
  '/developers': `# HireAlpha Developers

Public, unauthenticated API: GET /healthz, GET /api/public/info, GET /api/public/personas,
POST /api/waitlist. Rate limit 60 req/min per IP. OpenAPI at /openapi.json, llms.txt at
/llms.txt, sitemap at /sitemap.xml. Every HTML page answers Accept: text/markdown.
`,
  '/docs': `# HireAlpha API Docs

Base URL ${SITE_URL}. GET /healthz -> "ok". GET /api/public/info -> product metadata.
GET /api/public/personas -> the three personas. POST /api/waitlist {"email"} -> {"ok":true}.
Errors are {"error": "message"}. Unknown /api/* -> 404; unknown non-API -> 404 markdown.
`,
}

/** Markdown rendition of a content page, or null when we have none. */
export function markdownFor(pathname: string): string | null {
  if (pathname === '/' || pathname === '') return HOME_MD
  return PAGE_MD[pathname] ?? null
}

/** The 404 body: a short markdown note pointing agents at the real resources. */
export function notFoundMarkdown(pathname: string): string {
  return `# 404 — not found

\`${pathname}\` does not exist on ${SITE_URL}.

Useful starting points:
- Sitemap: ${SITE_URL}/sitemap.xml
- Agent guide: ${SITE_URL}/llms.txt
- OpenAPI: ${SITE_URL}/openapi.json
- Docs: ${SITE_URL}/docs
- Home: ${SITE_URL}/
`
}

export const PUBLIC_INFO = {
  name: 'HireAlpha',
  tagline: 'Hire Friend, Coworker, or Cofounder as AI contacts in iMessage.',
  pricing: { perPersonaMonthlyUsd: 19 },
  resources: {
    llmsTxt: `${SITE_URL}/llms.txt`,
    openapi: `${SITE_URL}/openapi.json`,
    sitemap: `${SITE_URL}/sitemap.xml`,
    developers: `${SITE_URL}/developers`,
    docs: `${SITE_URL}/docs`,
  },
}

export const PERSONAS = [
  {
    id: 'friend',
    name: 'Friend',
    live: true,
    description: 'Personal life on track: sleep, food, training, spending, and the people you owe a reply.',
  },
  {
    id: 'coworker',
    name: 'Coworker',
    live: false,
    description: 'Your workday: the one next action, meeting prep, draft review, scheduling, and issue triage.',
  },
  {
    id: 'cofounder',
    name: 'Cofounder',
    live: false,
    description: 'The company: pipeline, runway, decisions, and investor notes.',
  },
]
