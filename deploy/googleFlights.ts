/**
 * Google Flights, via scrape.do — the dated fare source behind trvl.
 *
 * Why: trvl's upstream providers rate-limit our datacenter IP (measured 429s
 * from kiwi and skiplagged), and a free plain fetch of Google Flights is
 * refused. scrape.do renders it from its own IPs, and the page carries real
 * fares for the requested dates (measured: JFK→ORD 2026-09-25→27 came back in
 * 7s with $325/$341/$361/$381 rows and airline names).
 *
 * The page is a JS bundle, so the fares are read the same way the browser path
 * reads them: a fenced extraction call, then `normalizeFlightRows`. That is the
 * machinery `spectrum/shared/flightExtract.ts` already provides and tests.
 */
import { airportsFor } from './trvl'
import { scrapeDoFetch, scrapeDoEnabled } from './scrapeDo'
import { flightExtractionPrompt, formatFares, normalizeFlightRows, wrapUntrustedPage } from '../spectrum/shared/flightExtract'
import { gmiChat } from '../spectrum/shared/gmi'

/** Visible text of a rendered page, with the scripts and styles dropped. The
 * extractor is told the content is untrusted, so this only needs to preserve
 * what a reader would see: airline names, times, prices. */
export function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type GoogleFlightsInput = {
  from: string
  to: string
  date: string
  returnDate?: string
  maxPriceUsd?: number
}

export async function googleFlightsRates(input: GoogleFlightsInput): Promise<string | null> {
  if (!scrapeDoEnabled()) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return null
  const from = airportsFor(input.from)
  const to = airportsFor(input.to)
  if (!from || !to) return null
  // One airport each side, same discipline as trvl: a city's every airport
  // multiplies the render cost for results the first pair already carries.
  const fromIata = from.split(',')[0]!
  const toIata = to.split(',')[0]!
  const q = input.returnDate
    ? `Flights to ${toIata} from ${fromIata} on ${input.date} through ${input.returnDate}`
    : `Flights to ${toIata} from ${fromIata} on ${input.date}`
  const url = `https://www.google.com/travel/flights?hl=en&curr=USD&q=${encodeURIComponent(q)}`
  const res = await scrapeDoFetch(url, { render: true })
  if (!res.ok) return null
  const text = pageText(res.body)
  if (text.length < 400) return null
  let reply = ''
  try {
    reply = await gmiChat({
      temperature: 0.1,
      maxTokens: 1200,
      reasoningEffort: 'low',
      timeoutMs: 45_000,
      messages: [
        {
          role: 'system',
          content: flightExtractionPrompt({
            sourceLabel: `Google Flights, ${fromIata} to ${toIata}${input.returnDate ? ' round trip' : ''}`,
            filters: {
              currency: 'USD',
              ...(input.maxPriceUsd && input.maxPriceUsd > 0 ? { maxPrice: input.maxPriceUsd } : {}),
            },
            searchDate: input.date,
            maxResults: 8,
          }),
        },
        // The rendered page's text, fenced as untrusted. Capped well below the
        // 2MB HTML: the visible text of a results page is tens of KB, and the
        // extractor only needs the rows.
        { role: 'user', content: wrapUntrustedPage(text, 40_000) },
      ],
    })
  } catch (err) {
    console.warn('[googleFlights] extraction failed', err instanceof Error ? err.message : err)
    return null
  }
  const rows = normalizeFlightRows(reply, {
    ...(input.maxPriceUsd && input.maxPriceUsd > 0 ? { maxPrice: input.maxPriceUsd } : {}),
    searchDate: input.date,
  })
  if (!rows.length) return null
  const label = input.returnDate
    ? `from ${from} to ${to}: out ${input.date}, back ${input.returnDate}`
    : `from ${from} to ${to} on ${input.date}`
  return `${formatFares(rows.slice(0, 8), { label })}`
}
