import { describe, expect, it } from 'bun:test'
import { fetchPageText, parseBingRss, parseBraveResults, parseDuckDuckGoResults, parseYahooResults, searchWeb, webSearchContext } from './webSearch'

describe('web search evidence', () => {
  it('does not let fast off-topic results cancel a relevant provider', async () => {
    const results = await searchWeb('94109 San Francisco restaurants official menu address', 5, (async input => {
      if (String(input).includes('bing.com')) return new Response('<rss><channel><item><title>94109 San Francisco homes for sale</title><link>https://example.com/homes</link><description>San Francisco real estate in 94109.</description></item></channel></rss>')
      if (String(input).includes('html.duckduckgo.com')) {
        await new Promise(resolve => setTimeout(resolve, 20))
        return new Response('<a class="result__a" href="https://sorellasf.com/">Sorella Restaurant</a><a class="result__snippet">Italian restaurant in San Francisco 94109.</a>')
      }
      return new Response('blocked', { status: 403 })
    }) as typeof fetch)
    expect(results.map(r => r.url)).toEqual(['https://sorellasf.com/'])
  })
  it('reads Bing RSS titles, links and descriptions', () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title>Official event</title><link>https://example.com/event</link><description>September 9 &amp; streaming live.</description></item><item><title>Official event</title><link>https://example.com/event</link><description>Dupe.</description></item></channel></rss>`
    expect(parseBingRss(xml)).toEqual([{ title: 'Official event', url: 'https://example.com/event', snippet: 'September 9 & streaming live.' }])
  })
  it('rejects script URLs and keeps only organic items', () => {
    const xml = `<rss><channel><item><title>Bad</title><link>javascript:alert(1)</link><description>x</description></item><item><title>Good</title><link>https://example.com</link><description>y</description></item></channel></rss>`
    expect(parseBingRss(xml).map(r => r.title)).toEqual(['Good'])
  })
  it('unwraps Yahoo redirect links and matches the compText snippet', () => {
    const html = `<a data-matarget="algo" href="https://r.search.yahoo.com/x/RU=https%3a%2f%2fexample.com%2frice/RK=2/RS=z"><h3><span>5 lb rice</span></h3></a><div class="compText aAbs"><p class="x">Product details</p></div><a data-matarget="algo" href="https://r.search.yahoo.com/x/RU=https%3a%2f%2fsearch.yahoo.com%2fzzz/RK=2/RS=z"><h3><span>Yahoo</span></h3></a>`
    expect(parseYahooResults(html)).toEqual([{ title: '5 lb rice', url: 'https://example.com/rice', snippet: 'Product details' }])
  })
  it('reads DuckDuckGo result anchors and unwraps uddg redirects', () => {
    const html = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fevent&amp;rut=x" class="result__a">Official <b>event</b></a><a class="result__snippet">September 9 &amp; streaming live.</a>`
    expect(parseDuckDuckGoResults(html)).toEqual([{ title: 'Official event', url: 'https://example.com/event', snippet: 'September 9 & streaming live.' }])
  })
  it('returns no fabricated search result when both providers fail', async () => {
    for (const response of [new Response('blocked', { status: 403 }), new Response('Rate limited', { status: 429 })]) {
      expect(await searchWeb('latest event', 5, (async () => response) as typeof fetch)).toEqual([])
    }
    expect(await searchWeb('latest event', 5, (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toEqual([])
  })
  it('rejects DuckDuckGo ad redirects, script URLs and duplicates', () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dshop.com">Ad</a><a class="result__a" href="javascript:alert(1)">Bad</a><a class="result__a" href="https://example.com">Good</a><a class="result__a" href="https://example.com">Duplicate</a>`
    expect(parseDuckDuckGoResults(html).map(r => r.title)).toEqual(['Good'])
  })
  it('falls through a failing provider to the next one', async () => {
    const urls: string[] = []
    const results = await searchWeb('rice', 5, (async input => {
      urls.push(String(input))
      const url = String(input)
      // Brave is asked first; when it answers with nothing usable, the next
      // provider in priority order is tried.
      if (url.startsWith('https://search.brave.com')) return new Response('<html><body>no results here</body></html>')
      if (url.startsWith('https://search.yahoo.com')) return new Response('<html><body>no results here</body></html>')
      if (url.startsWith('https://www.bing.com')) {
        return new Response(`<?xml version="1.0"?><rss><channel><item><title>5 lb rice</title><link>https://example.com/rice</link><description>Product details</description></item></channel></rss>`)
      }
      throw new Error('unused')
    }) as typeof fetch)
    expect(urls[0]).toStartWith('https://search.brave.com/search')
    expect(urls.some(u => u.startsWith('https://www.bing.com/search'))).toBe(true)
    expect(results).toEqual([{ title: '5 lb rice', url: 'https://example.com/rice', snippet: 'Product details' }])
  })
  it('reaches DuckDuckGo when Yahoo and Bing return nothing usable', async () => {
    const results = await searchWeb('rice', 5, (async input => {
      const url = String(input)
      if (url.startsWith('https://html.duckduckgo.com')) {
        return new Response(`<a href="https://example.com/rice" class='result-link'>5 lb rice</a><td class='result-snippet'>Product details</td>`)
      }
      return new Response('<rss><channel></channel></rss>')
    }) as typeof fetch)
    expect(results).toEqual([{ title: '5 lb rice', url: 'https://example.com/rice', snippet: 'Product details' }])
  })
})

describe('page opening', () => {
  const page = `<html><head><title>Menu</title><style>.x{color:red}</style><script>alert(1)</script></head><body><nav>Home Menus</nav><main><h1>Sorella</h1><p>${'Italian restaurant at 1760 Polk Street, San Francisco 94109. Wood-fired mains, natural wine, open late every night. '.repeat(6)}</p></main><footer>copyright</footer></body></html>`
  it('extracts readable text and strips scripts, styles, nav and footer', async () => {
    const text = await fetchPageText('https://sorellasf.com/', (async () => new Response(page, { headers: { 'content-type': 'text/html' } })) as typeof fetch)
    expect(text).toContain('Sorella')
    expect(text).toContain('1760 Polk Street')
    expect(text).not.toContain('alert(1)')
    expect(text).not.toContain('Home Menus')
    expect(text).not.toContain('copyright')
  })
  it('returns null on failure, non-HTML, or thin pages instead of fabricating', async () => {
    expect(await fetchPageText('https://example.com/', (async () => new Response('nope', { status: 403 })) as typeof fetch)).toBeNull()
    expect(await fetchPageText('https://example.com/f.pdf', (async () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })) as typeof fetch)).toBeNull()
    expect(await fetchPageText('https://example.com/', (async () => new Response('<html><body><p>hi</p></body></html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch)).toBeNull()
    expect(await fetchPageText('not a url')).toBeNull()
  })
})

describe('provider parsing and priority', () => {
  it('parses Brave results and drops its own pages', () => {
    const html = `
      <div class="snippet svelte-x" data-pos="1" data-type="web"><div class="result-content">
        <a href="https://www.walmart.com/ip/Great-Value-Jasmine-Rice-5-lb/36874821" target="_self"><div class="site-name-wrapper"><span>Walmart</span></div></a>
        <div class="title svelte-y">Great Value Jasmine Rice, 5 lb</div>
        <div class="snippet-description svelte-z">Long grain jasmine rice.</div>
      </div></div>
      <div class="snippet svelte-x" data-pos="2" data-type="web"><div class="result-content">
        <a href="https://search.brave.com/settings" target="_self"><div class="title">Settings</div></a>
      </div></div>`
    const results = parseBraveResults(html)
    expect(results).toHaveLength(1)
    expect(results[0]!.url).toContain('walmart.com')
    expect(results[0]!.title).toBe('Great Value Jasmine Rice, 5 lb')
  })

  it('keeps a result matching any meaningful query term', () => {
    // The bug this locks: requiring a majority of query words emptied shopping
    // results ("jasmine rice 5lb" pages that said "rice" but not "jasmine"),
    // and the turn then reported it could not finish.
    return searchWeb('jasmine rice 5lb', 6, (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('brave.com')) {
        return new Response(`
          <div class="snippet" data-pos="1" data-type="web"><a href="https://www.walmart.com/ip/Jasmine-Rice-5lb/260711604"><div class="title">Supreme Rice, Jasmine Rice 5lb Bag</div></a></div>`,
          { headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 500 })
    }) as typeof fetch).then(results => {
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.url).toContain('walmart.com')
    })
  })

  it('prefers the earlier provider instead of whoever answers first', async () => {
    // Bing used to win with the jasmine FLOWER because it answered faster than
    // Brave returned product pages.
    const results = await searchWeb('jasmine rice 5lb', 6, (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('brave.com')) {
        await new Promise(r => setTimeout(r, 120))
        return new Response(`
          <div class="snippet" data-pos="1" data-type="web"><a href="https://www.amazon.com/Mahatma/dp/B00TEST"><div class="title">Mahatma Jasmine Rice 5lb Bag</div></a></div>`,
          { headers: { 'content-type': 'text/html' } })
      }
      // Fast, irrelevant: the jasmine plant.
      return new Response(`<?xml version="1.0"?><rss><channel>
        <item><title>Jasmine - Wikipedia</title><link>https://en.wikipedia.org/wiki/Jasmine</link><description>Jasmine rice is a flower genus.</description></item>
      </channel></rss>`, { headers: { 'content-type': 'application/rss+xml' } })
    }) as typeof fetch)
    expect(results[0]!.url).toContain('amazon.com')
  })
})
