/* Provider race: Yahoo vs Bing RSS vs DuckDuckGo HTML, same queries, fired
 * in parallel. SearXNG excluded (no self-hosted instance running).
 * Run: bun scripts/search-race.ts [--limit=N] [--out=artifacts/search-race.json] */
import { parseBingRss, parseDuckDuckGoResults, parseYahooResults, type WebSearchResult } from '../deploy/webSearch'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// Same 100-query bench corpus (import-free copy to keep the script standalone).
const QUERIES: { q: string; local?: string }[] = [
  { q: 'nice restaurants 94109', local: '94109' },
  { q: 'best sushi near me 94109', local: '94109' },
  { q: 'tacos open late mission district', local: 'mission' },
  { q: 'good coffee soma', local: 'soma' },
  { q: 'italian restaurant north beach san francisco', local: 'san francisco' },
  { q: 'brunch spots hayes valley', local: 'hayes' },
  { q: 'cheap eats downtown berkeley', local: 'berkeley' },
  { q: 'pizza delivery 94110', local: '94110' },
  { q: 'vegan dinner austin', local: 'austin' },
  { q: 'ramen new york midtown', local: 'new york' },
  { q: 'best breakfast burrito los angeles', local: 'los angeles' },
  { q: 'cocktail bars chicago loop', local: 'chicago' },
  { q: 'seafood restaurant seattle waterfront', local: 'seattle' },
  { q: 'pho near me 02139', local: '02139' },
  { q: 'indian buffet mountain view', local: 'mountain view' },
  { q: 'steakhouse dallas uptown', local: 'dallas' },
  { q: 'dim sum san francisco richmond', local: 'san francisco' },
  { q: 'wine bar brooklyn williamsburg', local: 'brooklyn' },
  { q: 'food trucks portland downtown', local: 'portland' },
  { q: 'bakery croissant paris 11eme', local: 'paris' },
  { q: 'walgreens open 24 hours near 94109', local: '94109' },
  { q: 'dmv appointment san francisco', local: 'san francisco' },
  { q: 'post office hours saturday 94109', local: '94109' },
  { q: 'urgent care open now near me', local: '' },
  { q: 'bank of america atm soma', local: 'soma' },
  { q: 'parking garage near moscone center rates', local: 'moscone' },
  { q: 'laundromat open late oakland', local: 'oakland' },
  { q: 'gym with pool san francisco membership price', local: 'san francisco' },
  { q: 'barber shop walk ins hayes valley', local: 'hayes' },
  { q: 'nail salon open sunday berkeley', local: 'berkeley' },
  { q: 'iphone 17 price', local: '' },
  { q: 'cheapest displayport cable 6ft', local: '' },
  { q: 'le creuset dutch oven sale', local: '' },
  { q: 'standing desk under $300 reddit', local: '' },
  { q: 'best noise cancelling headphones 2026', local: '' },
  { q: 'used toyota rav4 hybrid price', local: '' },
  { q: 'costco mattress king review', local: '' },
  { q: 'espresso machine breville bambino plus sale', local: '' },
  { q: 'airbnb cleaning fee refund policy', local: '' },
  { q: 'southwest airlines checked bag fee', local: '' },
  { q: 'sfo to lax cheapest flights friday', local: 'sfo' },
  { q: 'bart schedule sfo to downtown', local: 'sfo' },
  { q: 'hotels near golden gate park under $200', local: 'golden gate' },
  { q: 'yosemite reservations required 2026', local: 'yosemite' },
  { q: 'big sur road closure status', local: 'big sur' },
  { q: 'amtrak coast starlight status today', local: '' },
  { q: 'passport renewal processing time right now', local: '' },
  { q: 'best time to visit japan cherry blossom 2027', local: 'japan' },
  { q: 'carry on size restrictions united airlines', local: '' },
  { q: 'caltrain weekend schedule san jose', local: 'san jose' },
  { q: 'earthquake today california', local: 'california' },
  { q: 'warriors score last night', local: '' },
  { q: 'giants game today time channel', local: '' },
  { q: 'stock market today dow jones', local: '' },
  { q: 'bitcoin price right now', local: '' },
  { q: 'weather san francisco this weekend', local: 'san francisco' },
  { q: 'air quality index 94109 today', local: '94109' },
  { q: 'power outage pg&e map', local: '' },
  { q: 'muni delays today', local: 'muni' },
  { q: 'who won the election yesterday', local: '' },
  { q: 'how to unclog drain without chemicals', local: '' },
  { q: 'how to cook perfect rice stovetop', local: '' },
  { q: 'how to file taxes freelance 1099', local: '' },
  { q: 'how to remove red wine stain couch', local: '' },
  { q: 'how to reset iphone without password', local: '' },
  { q: 'how to negotiate salary job offer email', local: '' },
  { q: 'how to start sourdough starter', local: '' },
  { q: 'how to fix leaky faucet youtube', local: '' },
  { q: 'how to dispute credit card charge chase', local: '' },
  { q: 'how to potty train toddler night', local: '' },
  { q: 'is advil or tylenol better for headache', local: '' },
  { q: 'how long does flu last adults', local: '' },
  { q: 'urgent care vs er cost', local: '' },
  { q: 'why do i wake up at 3am every night', local: '' },
  { q: 'best sunscreen face oily skin dermatologist', local: '' },
  { q: 'covid symptoms 2026 new variant', local: '' },
  { q: 'how much water should i drink daily', local: '' },
  { q: 'lower back pain sleeping position', local: '' },
  { q: 'is coffee bad for anxiety', local: '' },
  { q: 'vitamin d deficiency symptoms', local: '' },
  { q: 'roth ira contribution limit 2026', local: '' },
  { q: 'chase sapphire preferred annual fee', local: '' },
  { q: 'how to freeze credit equifax', local: '' },
  { q: 'apartment application fee limit california', local: 'california' },
  { q: 'security deposit return 21 days california', local: 'california' },
  { q: 'how to break lease early sf', local: '' },
  { q: 'renter insurance cost per month', local: '' },
  { q: 'best high yield savings account rate today', local: '' },
  { q: 'turbotax vs freetaxusa 2026', local: '' },
  { q: 'when is tax day 2027', local: '' },
  { q: 'what time is sunset today san francisco', local: 'san francisco' },
  { q: 'full moon calendar next 3 months', local: '' },
  { q: 'movies playing near me this weekend', local: '' },
  { q: 'free things to do sf this saturday', local: '' },
  { q: 'hiking trails marin easy parking', local: 'marin' },
  { q: 'dog friendly beaches bay area', local: 'bay area' },
  { q: 'where to watch fireworks july 4th san francisco', local: 'san francisco' },
  { q: 'farmers market sunday near 94109', local: '94109' },
  { q: 'live music tonight mission district', local: 'mission' },
  { q: 'second hand furniture store mission', local: 'mission' },
]

type Provider = 'yahoo' | 'bing' | 'ddg'
type Attempt = { ok: boolean; ms: number; count: number; avgSnippet: number; localHit: boolean | null; firstTitle: string }

async function attempt(provider: Provider, q: string, local: string): Promise<Attempt> {
  const t0 = Date.now()
  try {
    let url = ''
    let parse: (body: string, n: number) => WebSearchResult[] = parseYahooResults
    if (provider === 'yahoo') { url = `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`; parse = parseYahooResults }
    if (provider === 'bing') { url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`; parse = parseBingRss }
    if (provider === 'ddg') { url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`; parse = parseDuckDuckGoResults }
    const res = await Promise.race([
      fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('race budget')), 20000)),
    ])
    const ms = Date.now() - t0
    if (!res.ok) return { ok: false, ms, count: 0, avgSnippet: 0, localHit: null, firstTitle: `HTTP ${res.status}` }
    const results = parse(await res.text(), 6)
    if (!results.length) return { ok: false, ms, count: 0, avgSnippet: 0, localHit: null, firstTitle: 'empty parse' }
    const blob = results.map(r => `${r.title} ${r.url} ${r.snippet}`.toLowerCase()).join(' | ')
    const snips = results.map(r => r.snippet.length)
    return {
      ok: true, ms, count: results.length,
      avgSnippet: Math.round(snips.reduce((a, b) => a + b, 0) / snips.length),
      localHit: local ? blob.includes(local.toLowerCase()) : null,
      firstTitle: results[0]!.title.slice(0, 80),
    }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, count: 0, avgSnippet: 0, localHit: null, firstTitle: `error: ${(e as Error).message}` }
  }
}

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const LIMIT = Math.min(Number(args.limit || '100'), QUERIES.length)
const OUT = String(args.out || 'artifacts/search-race.json')

const data: Record<Provider, Attempt[]> = { yahoo: [], bing: [], ddg: [] }
const queue = QUERIES.slice(0, LIMIT)
let done = 0
async function worker() {
  while (queue.length) {
    const item = queue.shift()!
    const [y, b, d] = await Promise.all([
      attempt('yahoo', item.q, item.local || ''),
      attempt('bing', item.q, item.local || ''),
      attempt('ddg', item.q, item.local || ''),
    ])
    data.yahoo.push(y); data.bing.push(b); data.ddg.push(d)
    done++
    if (done % 10 === 0) console.log(`  ${done}/${LIMIT}...`)
  }
}
console.log(`race: ${LIMIT} queries x 3 providers, query-concurrency 6`)
const wall0 = Date.now()
await Promise.all(Array.from({ length: 6 }, worker))
console.log(`wall: ${Math.round((Date.now() - wall0) / 1000)}s`)

function score(name: Provider) {
  const rows = data[name]
  const ok = rows.filter(r => r.ok)
  const lat = ok.map(r => r.ms).sort((a, b) => a - b)
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0)
  const localRows = rows.filter(r => r.localHit !== null)
  const successRate = (ok.length / rows.length) * 100
  const localRate = localRows.length ? (localRows.filter(r => r.localHit).length / localRows.length) * 100 : 100
  const richRate = ok.length ? (ok.filter(r => r.avgSnippet >= 80).length / ok.length) * 100 : 0
  const p95 = pct(95)
  const speedScore = Math.max(0, 100 - Math.max(0, (p95 - 4000) / 100))
  return {
    provider: name,
    score: Math.round(successRate * 0.5 + localRate * 0.2 + richRate * 0.15 + speedScore * 0.15),
    successRate: +successRate.toFixed(1), p50Ms: pct(50), p95Ms: p95,
    localHitRate: +localRate.toFixed(1), richSnippetRate: +richRate.toFixed(1),
    failReasons: rows.filter(r => !r.ok).reduce<Record<string, number>>((m, r) => { m[r.firstTitle] = (m[r.firstTitle] || 0) + 1; return m }, {}),
  }
}

const table = (['yahoo', 'bing', 'ddg'] as Provider[]).map(score).sort((a, b) => b.score - a.score)
await Bun.write(OUT, JSON.stringify({ at: new Date().toISOString(), table }, null, 1))
console.log('\nPROVIDER RACE (same 100 queries, parallel):')
for (const t of table) {
  console.log(`  ${t.provider}: ${t.score}/100 | success ${t.successRate}% | p50 ${t.p50Ms}ms | p95 ${t.p95Ms}ms | local ${t.localHitRate}% | rich ${t.richSnippetRate}%`)
  console.log(`    fails: ${JSON.stringify(t.failReasons)}`)
}
console.log(`report: ${OUT}`)
