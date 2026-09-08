import { describe, expect, it } from 'bun:test'
import { fetchPageText, parseBingRss, parseDuckDuckGoResults, parseYahooResults, searchWeb, webSearchContext } from './webSearch'

describe('web search evidence', () => {
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
  it('first usable provider wins the race; losers are ignored', async () => {
    const urls: string[] = []
    const results = await searchWeb('rice', 5, (async input => {
      urls.push(String(input))
      const url = String(input)
      if (url.startsWith('https://search.yahoo.com')) return new Response('<html><body>no results here</body></html>')
      if (url.startsWith('https://www.bing.com')) {
        await new Promise(r => setTimeout(r, 20))
        return new Response(`<?xml version="1.0"?><rss><channel><item><title>5 lb rice</title><link>https://example.com/rice</link><description>Product details</description></item></channel></rss>`)
      }
      throw new Error('too slow')
    }) as typeof fetch)
    expect(urls[0]).toStartWith('https://search.yahoo.com/search')
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
