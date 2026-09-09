export type WebSearchResult = { title: string; url: string; snippet: string }

/** A provider returning HTML successfully is not enough: reject obvious topic
 * misses before it can win the race and abort the other providers. */
function relevantResults(query: string, rows: WebSearchResult[]): WebSearchResult[] {
  const ignored = new Set('a an the in at on for of to and or near me can you find search best nice good official website websites menu address latest please'.split(' '))
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) || [])].filter(t => t.length > 2 && !ignored.has(t))
  const dining = /\b(?:restaurants?|dining|dinner|cafes?|ristorante|pizzeria)\b/i.test(query)
  return rows.filter(row => {
    const content = `${row.title} ${row.snippet} ${row.url}`.toLowerCase()
    if (dining && !/\b(?:restaurants?|dining|dinner|cafes?|ristorante|bistro|pizzeria|steakhouse|seafood|italian|sushi)\b/i.test(content)) return false
    return !terms.length || terms.filter(t => content.includes(t.replace(/s$/, ''))).length >= Math.min(3, Math.ceil(terms.length / 2))
  })
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function plain(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&times;/g, 'x')
    .replace(/&#(?:39|x27);/gi, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}

function validUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch { return null }
}

/** Bing RSS is keyless and tolerates server IPs: <item><title><link><description>. */
export function parseBingRss(xml: string, limit = 6): WebSearchResult[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gis)]
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  for (const [, body] of items) {
    const pick = (tag: string) => plain(body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] || '')
    const url = validUrl(pick('link'))
    if (!url) continue
    const title = pick('title')
    if (!title || seen.has(url.href)) continue
    seen.add(url.href)
    results.push({ title, url: url.href, snippet: pick('description') })
    if (results.length >= Math.max(1, Math.min(limit, 10))) break
  }
  return results
}

/** Yahoo HTML fallback, also keyless. Organic anchors carry
 * data-matarget="algo" and the real destination hides in the
 * /RU=<url-encoded>/RK= redirect segment; the snippet sits in the
 * compText block right after the anchor. */
export function parseYahooResults(html: string, limit = 6): WebSearchResult[] {
  const anchors = [...html.matchAll(/<a\b([^>]*\bdata-matarget="algo"[^>]*)>([\s\S]*?)<\/a>/gis)]
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  for (let i = 0; i < anchors.length; i++) {
    const [full, attrs, label] = anchors[i]
    const href = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1] || ''
    const encoded = href.match(/\/RU=(.*?)\/RK=/i)?.[1]
    if (!encoded) continue
    let target: string
    try { target = decodeURIComponent(encoded) } catch { continue }
    const url = validUrl(target)
    if (!url || url.hostname.endsWith('yahoo.com')) continue
    const title = plain(label)
    if (!title || seen.has(url.href)) continue
    const next = anchors[i + 1]
    const tail = html.slice(anchors[i].index! + full.length, next?.index ?? html.length)
    const snippet = plain(tail.match(/<div\b[^>]*\bcompText\b[^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '')
    seen.add(url.href)
    results.push({ title, url: url.href, snippet })
    if (results.length >= Math.max(1, Math.min(limit, 10))) break
  }
  return results
}

/** DuckDuckGo HTML, last resort. Datacenter IPs are routinely starved or
 * challenged here, but when it answers the results are fresh. */
export function parseDuckDuckGoResults(html: string, limit = 6): WebSearchResult[] {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gis)]
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  for (let i = 0; i < anchors.length; i++) {
    const [full, attrs, label] = anchors[i]
    const classes = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1].split(/\s+/) || []
    if (!classes.includes('result__a') && !classes.includes('result-link')) continue
    const href = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1]
    if (!href) continue
    let url: URL | null
    try {
      const parsed = new URL(plain(href), 'https://duckduckgo.com')
      if (parsed.hostname === 'duckduckgo.com' || parsed.hostname.endsWith('.duckduckgo.com')) {
        const target = parsed.searchParams.get('uddg')
        if (!target) continue
        url = validUrl(target)
      } else {
        url = validUrl(parsed.href)
      }
    } catch { continue }
    if (!url || /\/aclick\b/.test(url.pathname)) continue
    if (url.hostname === 'duckduckgo.com' || url.hostname.endsWith('.duckduckgo.com')) continue
    const title = plain(label)
    if (!title || seen.has(url.href)) continue
    const nextResult = anchors.slice(i + 1).find(a => /\b(?:result__a|result-link)\b/.test(a[1]))
    const tail = html.slice(anchors[i].index! + full.length, nextResult?.index ?? html.length)
    const snippet = plain(tail.match(/<(?:a|div|span|td)\b[^>]*class=["'][^"']*\b(?:result__snippet|result-snippet)\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i)?.[1] || '')
    seen.add(url.href)
    results.push({ title, url: url.href, snippet })
    if (results.length >= Math.max(1, Math.min(limit, 10))) break
  }
  return results
}

/** Open a recommended URL and extract readable text. Returns null when the
 * page blocks bots, fails, or yields nothing — never fabricated content.
 * Bounded: 12s timeout, ~4000 characters, HTML junk stripped. */
export async function fetchPageText(rawUrl: string, request: typeof fetch = fetch, timeoutMs = 12000): Promise<string | null> {
  const url = validUrl(rawUrl)
  if (!url) return null
  try {
    const response = await request(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') || ''
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return null
    const html = await response.text()
    if (!html || html.length > 2_000_000) return null
    const text = plain(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<header[\s\S]*?<\/header>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' '),
    )
    if (text.length < 200) return null
    return text.slice(0, 4000)
  } catch { return null }
}
export async function searchWeb(query: string, limit = 6, request: typeof fetch = fetch): Promise<WebSearchResult[]> {
  const q = query.trim().slice(0, 500)
  if (!q) return []
  // Cascade: Yahoo HTML, Bing RSS, DuckDuckGo HTML, DuckDuckGo Lite.
  // All free with no API key. Yahoo first: its relevance actually honors
  // ZIP codes and local intent, where Bing RSS matches words literally
  // ("best" -> Best Buy). DuckDuckGo last: routinely starved from servers.
  const attempts: Array<{ url: URL; parse: (body: string, limit: number) => WebSearchResult[]; timeout: number }> = []
  const yahoo = new URL('https://search.yahoo.com/search')
  yahoo.searchParams.set('p', q)
  attempts.push({ url: yahoo, parse: parseYahooResults, timeout: 4000 })
  const bing = new URL('https://www.bing.com/search')
  bing.searchParams.set('q', q)
  bing.searchParams.set('format', 'rss')
  attempts.push({ url: bing, parse: parseBingRss, timeout: 4000 })
  // Last resort: DuckDuckGo HTML then Lite. Often starved or challenged
  // from server IPs, but fresh when it answers.
  const ddg = new URL('https://html.duckduckgo.com/html/')
  ddg.searchParams.set('q', q)
  attempts.push({ url: ddg, parse: parseDuckDuckGoResults, timeout: 4000 })
  const ddgLite = new URL('https://lite.duckduckgo.com/lite/')
  ddgLite.searchParams.set('q', q)
  attempts.push({ url: ddgLite, parse: parseDuckDuckGoResults, timeout: 3000 })
  // Race: all free providers fire in parallel, first with usable results
  // wins. Misses stay pending (a settled null would win the race and
  // starve slower providers); losers are aborted once a winner lands.
  const controller = new AbortController()
  const pending = new Promise<never>(() => {})
  const run = async (url: URL, parse: (body: string, limit: number) => WebSearchResult[], timeout: number): Promise<WebSearchResult[] | null> => {
    try {
      const response = await request(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/rss+xml,application/xml' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
      })
      if (!response.ok) return null
      const results = relevantResults(q, parse(await response.text(), limit))
      return results.length ? results : null
    } catch { return null }
  }
  try {
    const runners = attempts.map(a => run(a.url, a.parse, a.timeout))
    const winner = await Promise.race([
      ...runners.map(p => p.then(r => {
        if (!r) return pending
        controller.abort()
        return r
      })),
      // Every provider missed: resolve null as soon as the last one
      // settles instead of waiting out a fixed timeout. Each runner is
      // already bounded by its own deadline (3-4s).
      Promise.allSettled(runners).then(() => null),
    ])
    return winner || []
  } finally {
    controller.abort()
  }
}

const BOT_BLOCKED_HOSTS = new Set([
  'amazon.com', 'www.amazon.com', 'walmart.com', 'www.walmart.com',
  'target.com', 'www.target.com', 'ebay.com', 'www.ebay.com',
  'dominos.com', 'www.dominos.com', 'yelp.com', 'www.yelp.com',
  'tripadvisor.com', 'www.tripadvisor.com', 'slickdeals.net', 'www.slickdeals.net',
])

export async function webSearchContext(query: string): Promise<string> {
  const results = await searchWeb(query)
  if (!results.length) return 'Web search unavailable or returned no usable results. No current facts were verified. Do not claim you searched successfully or answer time-sensitive facts from memory.'

  const isShopping = /\b(?:buy|price|prices|order|shop|product|bag|rice|shirt|item|domino|cost)\b/i.test(query)
  const candidate = isShopping
    ? null
    : results.slice(0, 3).find(r => {
        try {
          const host = new URL(r.url).hostname.toLowerCase()
          return !BOT_BLOCKED_HOSTS.has(host)
        } catch { return false }
      })

  let page = ''
  if (candidate) {
    const text = await fetchPageText(candidate.url, fetch, 2000).catch(() => null)
    if (text) {
      page = `\nOpened ${candidate.url} (page text excerpt, up to 4000 characters):\n${text}`
    }
  }

  return `Web search retrieved at ${new Date().toISOString()}. Snippets are source excerpts, not verified page contents; publication dates may differ.\n${results.map(r => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`).join('\n')}${page}`
}
