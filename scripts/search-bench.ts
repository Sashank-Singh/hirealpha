/* Search benchmark: 100 realistic human queries against the Alpha web
 * cascade (Yahoo -> Bing RSS -> DDG HTML -> DDG Lite). Scores success rate,
 * latency, snippet quality, and local-intent hits. Run with:
 *   bun scripts/search-bench.ts [--limit=N] [--out=artifacts/search-bench.json]
 * Live network; takes a few minutes at concurrency 8. */
import { searchWeb } from '../deploy/webSearch'

const QUERIES: { q: string; local?: string }[] = [
  // Food & local (the Alpha core: ZIP-aware restaurant asks)
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
  // Hours / practical local
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
  // Shopping & prices
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
  // Travel
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
  // News & current
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
  // How-to & explainers
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
  // Health
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
  // Money & admin
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
  // Fun & misc human asks
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

type Row = {
  q: string; ok: boolean; ms: number; count: number; provider: string
  avgSnippet: number; localHit: boolean | null; firstTitle: string; firstUrl: string
}

function providerOf(urls: string[]): string {
  // Winner is the LAST endpoint attempted: searchWeb returns on first success.
  for (const u of [...urls].reverse()) {
    if (/search\.yahoo\.com\/search/.test(u)) return 'yahoo'
    if (/bing\.com\/search/.test(u)) return 'bing'
    if (/duckduckgo\.com/.test(u)) return 'ddg'
  }
  return 'unknown'
}

async function runOne(q: string, local: string): Promise<Row> {
  const seen: string[] = []
  const t0 = Date.now()
  let results: Awaited<ReturnType<typeof searchWeb>> = []
  try {
    // Wrap fetch to record which provider endpoints were hit.
    const spy = (async (input: URL | RequestInfo, init?: RequestInit) => {
      seen.push(String(input instanceof URL ? input.href : (input as Request).url ?? input))
      return fetch(input as URL, init)
    }) as typeof fetch
    results = await Promise.race([
      searchWeb(q, 6, spy),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bench budget')), 45000)),
    ])
  } catch { results = [] }
  const ms = Date.now() - t0
  const snippets = results.map(r => r.snippet.length)
  const blob = results.map(r => `${r.title} ${r.url} ${r.snippet}`.toLowerCase()).join(' | ')
  return {
    q, ok: results.length > 0, ms, count: results.length,
    provider: results.length ? providerOf(seen) : 'none',
    avgSnippet: snippets.length ? Math.round(snippets.reduce((a, b) => a + b, 0) / snippets.length) : 0,
    localHit: local ? blob.includes(local.toLowerCase()) : null,
    firstTitle: results[0]?.title.slice(0, 80) || '',
    firstUrl: results[0]?.url || '',
  }
}

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const LIMIT = Math.min(Number(args.limit || '100'), QUERIES.length)
const OUT = String(args.out || 'artifacts/search-bench.json')
const CONCURRENCY = 8

const queue = QUERIES.slice(0, LIMIT)
const rows: Row[] = []
let done = 0
async function worker() {
  while (queue.length) {
    const item = queue.shift()!
    rows.push(await runOne(item.q, item.local || ''))
    done++
    if (done % 10 === 0) console.log(`  ${done}/${LIMIT}...`)
  }
}
console.log(`bench: ${LIMIT} queries, concurrency ${CONCURRENCY}`)
const wall0 = Date.now()
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, LIMIT) }, worker))
const wallMs = Date.now() - wall0

const ok = rows.filter(r => r.ok)
const byProvider: Record<string, number> = {}
for (const r of ok) byProvider[r.provider] = (byProvider[r.provider] || 0) + 1
const lat = ok.map(r => r.ms).sort((a, b) => a - b)
const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0)
const localRows = rows.filter(r => r.localHit !== null)
const localHits = localRows.filter(r => r.localHit).length
const richSnippets = ok.filter(r => r.avgSnippet >= 80).length

// Composite 0-100: success 50pts, local intent 20pts, snippet richness 15pts, speed 15pts.
const successRate = (ok.length / rows.length) * 100
const localRate = localRows.length ? (localHits / localRows.length) * 100 : 100
const richRate = ok.length ? (richSnippets / ok.length) * 100 : 0
const p95 = pct(95)
const speedScore = Math.max(0, 100 - Math.max(0, (p95 - 4000) / 100))
const score = Math.round(successRate * 0.5 + localRate * 0.2 + richRate * 0.15 + speedScore * 0.15)

const report = {
  at: new Date().toISOString(), queries: rows.length, wallMs,
  score,
  metrics: {
    successRate: +successRate.toFixed(1),
    p50Ms: pct(50), p95Ms: p95,
    byProvider,
    localHitRate: +(localRate.toFixed(1)),
    richSnippetRate: +(richRate.toFixed(1)),
  },
  failures: rows.filter(r => !r.ok).map(r => r.q),
  slowest: [...rows].sort((a, b) => b.ms - a.ms).slice(0, 5).map(r => `${r.q} (${r.ms}ms)`),
  rows,
}
await Bun.write(OUT, JSON.stringify(report, null, 1))
console.log(`\nSCORE: ${score}/100`)
console.log(`success ${report.metrics.successRate}% | p50 ${report.metrics.p50Ms}ms | p95 ${report.metrics.p95Ms}ms`)
console.log(`providers ${JSON.stringify(byProvider)} | local-hit ${report.metrics.localHitRate}% | rich-snippet ${report.metrics.richSnippetRate}%`)
console.log(`failures (${report.failures.length}): ${report.failures.slice(0, 10).join(' / ')}`)
console.log(`report: ${OUT}`)
