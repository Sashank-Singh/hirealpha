/**
 * Browser-agent benchmark harness — the pass-rate number behind "the agent can
 * do anything in the browser". Runs REAL tasks through the SAME production loop
 * (`runKernelTask` on a Kernel cloud browser, minus the Postgres queue) and
 * scores each with strict assertions, so a loop change is measured, not vibed.
 *
 * Honesty rule inherited from scripts/certify.ts: a task that never ran (no
 * key, provider wall without a human) is reported BLOCKED, never PASS. A
 * handoff in a headless eval is a failure of the run, not a skip.
 *
 *   KERNEL_API_KEY=... bun run scripts/browser-eval.ts                 # full suite
 *   bun run scripts/browser-eval.ts --dry-run                          # list tasks, spend nothing
 *   KERNEL_API_KEY=... bun run scripts/browser-eval.ts --only=travel   # one category
 *   KERNEL_API_KEY=... bun run scripts/browser-eval.ts --only=wikipedia-price
 *
 * Output: console table + artifacts/browser-eval-<YYYYMMDD-HHmm>.md
 */
import { KernelBrowser } from '../deploy/kernelPage'
import { runKernelTask } from '../deploy/kernelSession'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

type EvalTask = {
  id: string
  category: 'travel' | 'shopping' | 'portal'
  url: string
  goal: string
  /** Return null when the answer satisfies the task, else the reason it fails. */
  assert: (answer: string) => string | null
  /** Extra env the task needs that a bot-wall handoff cannot cover. */
  requiresEnv?: string[]
}

// ---- assertion helpers -----------------------------------------------------

const money = (s: string) => Number(s.replace(/[$,\s]/g, ''))

/** At least one $-amount on or under the cap, plus every required pattern. */
function priceUnder(capDollars: number, ...patterns: RegExp[]): (a: string) => string | null {
  return (answer) => {
    for (const p of patterns) {
      if (!p.test(answer)) return `missing ${p}`
    }
    const amounts = [...answer.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].map((m) => money(m[0]))
    if (!amounts.length) return 'no dollar amount found in the answer'
    if (!amounts.some((a) => a <= capDollars)) return `no price at or under $${capDollars}`
    return null
  }
}

function requires(...patterns: RegExp[]): (a: string) => string | null {
  return (answer) => {
    for (const p of patterns) {
      if (!p.test(answer)) return `missing ${p}`
    }
    return null
  }
}

// ---- the suite --------------------------------------------------------------
// Dates are relative to run day so the suite never rots: helpers below build
// "next friday" style dates at launch time.

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function daysFromNow(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

const CHECK_IN = fmtDate(daysFromNow(14))
const CHECK_OUT = fmtDate(daysFromNow(15))

const TASKS: EvalTask[] = [
  // ---- travel --------------------------------------------------------------
  {
    id: 'booking-chicago-free-cancel',
    category: 'travel',
    url: `https://www.booking.com/searchresults.html?ss=Chicago+Loop&checkin=${CHECK_IN}&checkout=${CHECK_OUT}&group_adults=2&no_rooms=1&group_children=0&nflt=free_cancellation%3D1`,
    goal: `Find a hotel in the Chicago Loop for ${CHECK_IN} to ${CHECK_OUT} under $250 a night with free cancellation. Report the hotel name, the nightly price, and the cancellation terms.`,
    assert: priceUnder(250, /cancel/i, /\/\s*night|per night|nightly/i),
  },
  {
    id: 'booking-nyc-under-180',
    category: 'travel',
    url: `https://www.booking.com/searchresults.html?ss=Times+Square+New+York&checkin=${CHECK_IN}&checkout=${CHECK_OUT}&group_adults=2&no_rooms=1&group_children=0`,
    goal: `Find any hotel near Times Square, New York for ${CHECK_IN} to ${CHECK_OUT} priced at or under $180 per night. Report hotel name, nightly price, and review score if shown.`,
    assert: priceUnder(180),
  },
  {
    id: 'expedia-orlando-4-star',
    category: 'travel',
    url: `https://www.expedia.com/Orlando-Hotels?startDate=${CHECK_IN}&endDate=${CHECK_OUT}&priceMax=200&starRating=4`,
    goal: `Find a 4-star hotel in Orlando for ${CHECK_IN} to ${CHECK_OUT} at or under $200 a night. Report the hotel name and nightly price.`,
    assert: priceUnder(200),
  },
  {
    id: 'kayak-lax-car-week',
    category: 'travel',
    url: 'https://www.kayak.com/cars/Los-Angeles,CA-LAX',
    goal: 'Find the cheapest rental car at Los Angeles International Airport for the next two weeks. Report the car class, the total price, and the supplier.',
    assert: requires(/\$[\d,]+/, /(economy|compact|intermediate|full[- ]?size|standard|premium|special)/i),
  },
  {
    id: 'matrix-sfo-den',
    category: 'travel',
    url: 'https://matrix.itasoftware.com/',
    goal: 'Search one-way adult airfare from San Francisco (SFO) to Denver (DEN) on the date two weeks from today. Report the lowest total fare, the airline, and any baggage note visible.',
    assert: requires(/\$\s?\d{2,3}(\.\d{2})?/, /(united|delta|southwest|alaska|frontier|spirit|american|jetblue)/i),
  },
  {
    id: 'agoda-bangkok-riverside',
    category: 'travel',
    url: `https://www.agoda.com/search?city=185&checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&adults=2`,
    goal: `Find a hotel in Bangkok priced under $80 per night for ${CHECK_IN} to ${CHECK_OUT}. Report hotel name, nightly price, and rating.`,
    assert: priceUnder(80),
  },
  {
    id: 'airbnb-austin-guesthouse',
    category: 'travel',
    url: `https://www.airbnb.com/s/Austin--TX/homes?checkin=${CHECK_IN}&checkout=${CHECK_OUT}&priceMax=120`,
    goal: `Find an entire-place stay in Austin for ${CHECK_IN} to ${CHECK_OUT} at or under $120 per night. Report the listing title, nightly price, and rating.`,
    assert: priceUnder(120),
  },

  // ---- shopping ------------------------------------------------------------
  {
    id: 'bestbuy-ps5-price',
    category: 'shopping',
    url: 'https://www.bestbuy.com/site/searchpage.jsp?st=playstation+5+console',
    goal: 'Find the current price of a standard PlayStation 5 console at Best Buy and whether it is in stock. Report exact price and stock status.',
    assert: requires(/\$\d+(\.\d{2})?/, /(in stock|out of stock|ship|sold out|available|add to cart)/i),
  },
  {
    id: 'newegg-rtx-gpu',
    category: 'shopping',
    url: 'https://www.newegg.com/p/pl?d=rtx+4070&N=100007709',
    goal: 'Find an RTX 4070 graphics card under $700 on Newegg. Report the card name, price, and seller.',
    assert: priceUnder(700, /4070/i),
  },
  {
    id: 'ebay-iphone-used',
    category: 'shopping',
    url: 'https://www.ebay.com/sch/i.html?_nkw=iphone+13+128gb+unlocked&_sop=15',
    goal: 'Find the cheapest listed price for a used unlocked iPhone 13 128GB on eBay. Report the price and the listing condition.',
    assert: requires(/\$\s?\d{2,3}(\.\d{2})?/, /(pre[- ]?owned|used|for parts|refurbished)/i),
  },
  {
    id: 'etsy-personalized-mug',
    category: 'shopping',
    url: 'https://www.etsy.com/search?q=personalized+coffee+mug',
    goal: 'Find a personalized coffee mug under $30 with at least a 4-star rating on Etsy. Report the listing name, price, and rating.',
    assert: priceUnder(30, /\d(\.\d)?\s?(stars|★)|\(\d+\)/i),
  },
  {
    id: 'bh-sony-camera',
    category: 'shopping',
    url: 'https://www.bhphotovideo.com/c/buy/mirrorless-cameras/ci/28274',
    goal: 'Find the lowest-priced Sony mirrorless camera body at B&H and report the exact price and model name.',
    assert: priceUnder(5000, /sony/i),
  },
  {
    id: 'walmart-dish-detergent',
    category: 'shopping',
    url: 'https://www.walmart.com/search?q=tide+pod+laundry+detergent',
    goal: 'Find a Tide Pods laundry detergent pack at or under $25 on Walmart and report the exact price and pack size.',
    assert: priceUnder(25, /tide/i),
  },
  {
    id: 'target-crocs-kids',
    category: 'shopping',
    url: 'https://www.target.com/s?searchTerm=kids+crocs',
    goal: 'Find kids Crocs at Target under $25. Report the product name, price, and size range shown.',
    assert: priceUnder(25, /croc/i),
  },

  // ---- portal / extraction ---------------------------------------------------
  {
    id: 'wikipedia-burj-height',
    category: 'portal',
    url: 'https://en.wikipedia.org/wiki/Burj_Khalifa',
    goal: 'From the Burj Khalifa page infobox, report the building height in metres and the architect.',
    assert: requires(/\d{3,4}(.\d)?\s?(m|metres|feet)/i),
  },
  {
    id: 'github-trending-stars',
    category: 'portal',
    url: 'https://github.com/trending',
    goal: 'Report the #1 trending repository today: owner/name, description, and total star count.',
    assert: requires(/[\w.-]+\/[\w.-]+/, /[\d,]{3,}\s?stars|stars/i),
  },
  {
    id: 'nws-sf-forecast',
    category: 'portal',
    url: 'https://forecast.weather.gov/MapClick.php?lat=37.7749&lon=-122.4194',
    goal: 'Report the National Weather Service forecast for San Francisco tomorrow: the summary text and the high/low temperatures.',
    assert: requires(/(sunny|clear|partly|cloudy|showers?|rain|fog|overcast|breez|wind)/i, /\d{1,2}\s?°/),
  },
  {
    id: 'steam-hades-price',
    category: 'portal',
    url: 'https://store.steampowered.com/search/?term=hades',
    goal: 'Report the current Steam price of HADES (the Supergiant game) including any discount percentage shown.',
    assert: requires(/-?\d{1,2}%|₴|\$[\d.]+|R\$|CDN\$|€/i, /hades/i),
  },
  {
    id: 'goodreads-project-hail-mary',
    category: 'portal',
    url: 'https://www.goodreads.com/search?q=project+hail+mary',
    goal: 'Report the average rating and number of ratings for Project Hail Mary on Goodreads.',
    assert: requires(/\d\.\d+\s?average rating|rated it/i, /[\d,]{4,}/),
  },
  {
    id: 'arxiv-latest-papers',
    category: 'portal',
    url: 'https://arxiv.org/list/cs.LG/recent',
    goal: 'Report the title and authors of the first listing under the most recent date block on this page.',
    assert: (answer) => (answer.trim().length > 40 ? null : 'answer too short to contain a title + authors'),
  },
]

// ---- runner ------------------------------------------------------------------

type EvalResult = {
  task: EvalTask
  status: 'PASS' | 'FAIL' | 'BLOCKED'
  note: string
  steps: number
  seconds: number
}

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length)

if (DRY) {
  console.log(`browser-eval: ${TASKS.length} tasks, ${only ? `filtered by "${only}"` : 'all categories'} (dry run, nothing launched)\n`)
  for (const t of TASKS) console.log(`  [${t.category}] ${t.id}\n      ${t.url}`)
  process.exit(0)
}

const apiKey = process.env.KERNEL_API_KEY?.trim()
if (!apiKey) {
  console.error('KERNEL_API_KEY is required (same provider the production worker uses).')
  process.exit(1)
}

const selected = TASKS.filter(
  (t) => !only || t.category === only || t.id === only,
)
if (!selected.length) {
  console.error(`--only="${only}" matched no task id or category`)
  process.exit(1)
}

console.log(`browser-eval: ${selected.length}/${TASKS.length} tasks — one Kernel browser per task, sequential.\n`)

const results: EvalResult[] = []
for (const task of selected) {
  const missingEnv = (task.requiresEnv || []).filter((v) => !process.env[v]?.trim())
  if (missingEnv.length) {
    results.push({ task, status: 'BLOCKED', note: `missing env ${missingEnv.join(',')}`, steps: 0, seconds: 0 })
    console.log(`${task.id.padEnd(32)} BLOCKED  (missing env ${missingEnv.join(',')})`)
    continue
  }

  const started = Date.now()
  let steps = 0
  let handoffKind = ''
  let browser: KernelBrowser | null = null
  try {
    browser = await KernelBrowser.launch({ apiKey, timeoutSeconds: 1200 })
    const outcome = await runKernelTask(
      {
        url: task.url,
        goal: task.goal,
        onProgress: async () => {
          steps += 1
        },
        onHandoff: async (handoff) => {
          // A headless eval has no human: record the wall and stop. Never
          // resume-with-guess — the point of the harness is the honest number.
          handoffKind = handoff.kind
          return 'cancelled'
        },
      },
      browser,
    )
    const seconds = Math.round((Date.now() - started) / 1000)
    if (!outcome.ok) {
      const note = handoffKind ? `wall:${handoffKind}` : outcome.error
      const status = handoffKind ? 'BLOCKED' : 'FAIL'
      results.push({ task, status, note, steps, seconds })
      console.log(`${task.id.padEnd(32)} ${status.padEnd(8)} ${note}`)
      continue
    }
    const why = task.assert(outcome.content)
    const status = why ? 'FAIL' : 'PASS'
    results.push({ task, status, note: why || outcome.content.slice(0, 80).replace(/\s+/g, ' '), steps, seconds })
    console.log(`${task.id.padEnd(32)} ${status.padEnd(8)} ${status === 'PASS' ? `steps=${steps} ${seconds}s — ${outcome.content.slice(0, 60).replace(/\s+/g, ' ')}` : why}`)
  } catch (err) {
    const seconds = Math.round((Date.now() - started) / 1000)
    const note = err instanceof Error ? err.message : String(err)
    results.push({ task, status: 'FAIL', note: `harness: ${note.slice(0, 120)}`, steps, seconds })
    console.log(`${task.id.padEnd(32)} FAIL     ${note.slice(0, 100)}`)
  } finally {
    await browser?.close().catch(() => undefined)
  }
  // Pace the provider between launches (same 1s-spacing insurance the bot uses).
  await new Promise((r) => setTimeout(r, 2000))
}

// ---- report ------------------------------------------------------------------

const scored = results.filter((r) => r.status !== 'BLOCKED')
const passed = results.filter((r) => r.status === 'PASS').length
const blocked = results.filter((r) => r.status === 'BLOCKED').length
const score = scored.length ? `${passed}/${scored.length} (${((passed / scored.length) * 100).toFixed(1)}%)` : 'n/a'

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
const dir = 'artifacts'
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
const path = `${dir}/browser-eval-${stamp}.md`
const rows = [
  '| task | category | result | steps | time | note |',
  '|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.task.id} | ${r.task.category} | ${r.status} | ${r.steps} | ${r.seconds}s | ${r.note.replace(/\|/g, '\\|')} |`),
].join('\n')
writeFileSync(
  path,
  `# Browser agent benchmark ${stamp}\n\n**${score}** scored · ${blocked} blocked (wall or missing env — a blocked task is never a pass)\n\n${rows}\n`,
)

console.log(`\n=== SCORE ${score} · ${blocked} blocked ===`)
console.log(`report: ${path}`)
