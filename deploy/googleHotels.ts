/**
 * Google Hotels, via scrape.do. The dated-rate source that does not need a
 * SerpAPI key: the search page renders real prices for the exact check-in and
 * check-out, and the results travel in an `AF_initDataCallback` blob as
 * `["Name","<url>","$price",null,<id>,<rating>,…]`.
 *
 * Two honest limits, both surfaced in the block's own wording:
 *  - The figures are per-night rates: measured by fetching the same search for
 *    one night and for two, which returned identical prices.
 *  - A rendering call costs a credit and ~5s; the module that fetches it holds
 *    the budget.
 *  - Cancellation terms are not on this page (the search results do not carry
 *    the free-cancellation flag trvl's rows sometimes do), so the block says so
 *    instead of implying them.
 */
import { scrapeDoFetch, scrapeDoEnabled } from './scrapeDo'

export type GoogleHotelRow = {
  name: string
  priceUsd: number
  rating: number | null
}

/** The hotel rows in a rendered Google Hotels page, in page order. */
export function parseGoogleHotelRows(html: string): GoogleHotelRow[] {
  const out: GoogleHotelRow[] = []
  const seen = new Set<string>()
  /* name, the aclk url, then the price as a string with a $ — the tuple shape
   * Google's own bundle uses. The rating (if present) is the float after the
   * numeric id. */
  const pattern = /\["([^"]{3,80})","((?:[^"\\]|\\.)*)","\$([\d,]{2,9})",null,(\d+)(?:,(\d(?:\.\d)?))?/g
  for (const m of html.matchAll(pattern)) {
    const name = m[1]!.replace(/\s+/g, ' ').trim()
    const price = Number(m[3]!.replace(/,/g, ''))
    if (!name || !Number.isFinite(price) || price <= 0) continue
    // The same property repeats across the page (map rail, list, ads).
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const rating = m[5] ? Number(m[5]) : NaN
    out.push({ name, priceUsd: price, rating: Number.isFinite(rating) ? rating : null })
  }
  return out
}

export type GoogleHotelsInput = {
  city: string
  checkin: string
  checkout: string
  maxPriceUsd?: number
  maxResults?: number
}

/**
 * The block the model answers from, or null. Never a listicle: when the render
 * fails the caller falls to its next source, and eventually to the honest
 * "live pricing could not be verified".
 */
export async function googleHotelsRates(input: GoogleHotelsInput): Promise<string | null> {
  if (!scrapeDoEnabled()) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(input.checkout)) return null
  const city = String(input.city || '').trim().slice(0, 80)
  if (!city) return null
  const url = new URL('https://www.google.com/travel/search')
  url.searchParams.set('q', `hotels ${city}`)
  url.searchParams.set('checkin', input.checkin)
  url.searchParams.set('checkout', input.checkout)
  url.searchParams.set('currency', 'USD')
  url.searchParams.set('hl', 'en')
  const res = await scrapeDoFetch(url.toString(), { render: true })
  if (!res.ok) return null
  const rows = parseGoogleHotelRows(res.body)
  if (!rows.length) {
    console.warn('[googleHotels] render returned no parsable rows')
    return null
  }
  const ceiling = input.maxPriceUsd && input.maxPriceUsd > 0 ? input.maxPriceUsd : null
  const inBudget = ceiling ? rows.filter((r) => r.priceUsd <= ceiling) : rows
  const shown = (inBudget.length ? inBudget : rows).slice(0, input.maxResults ?? 8)
  const lines = shown.map((r) => `- ${r.name}: $${r.priceUsd}/night${r.rating ? `, rated ${r.rating}` : ''}`)
  return [
    `Live hotel rates for ${input.checkin} to ${input.checkout} in ${city} (Google Hotels, rendered for these nights):`,
    lines.join('\n'),
    ceiling && inBudget.length
      ? `Only properties at or under $${ceiling}/night are listed. These are per-night rates for those dates; the exact cancellation terms come from the booking page, so do not promise them.`
      : ceiling
        // Nothing met the ceiling: say that rather than quietly listing over-budget
        // rows as if they qualified.
        ? `Nothing at or under $${ceiling}/night came back from this source; these are the closest options, all ABOVE the stated ceiling, so say that plainly instead of presenting one as the pick. Cancellation terms come from the booking page.`
        : `These are per-night rates for those dates; the exact cancellation terms come from the booking page, so do not promise them.`,
  ].join('\n')
}
