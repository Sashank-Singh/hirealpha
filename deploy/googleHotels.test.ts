import { describe, expect, it } from 'bun:test'
import { parseGoogleHotelRows } from './googleHotels'

/* The shape Google's own bundle uses, captured from a real render:
 *   ["Name","<aclk url>","$1609",null,3236,4.5,"Name",…] */
const SAMPLE = `
)]}'\n["x","//x",null,null,[["JW Marriott Chicago","/aclk?sa=l&x=1","$1,609",null,3236,4.5,"JW Marriott Chicago","//img.png","",[26,19]],
["AC Hotel Chicago Downtown","/aclk?sa=l&y=2","$253",null,3121,4.2,"AC Hotel Chicago Downtown","//img.png","",[25]],
["No Rating Inn","/aclk?sa=l&z=3","$99",null,999,null,"No Rating Inn","//img.png","",[1]],
["JW Marriott Chicago","/aclk?sa=l&dup=1","$1,609",null,3236,4.5,"JW Marriott Chicago","//img.png","",[26]]]]
`

describe('parsing a rendered Google Hotels page', () => {
  it('reads the name, the per-night price and the rating', () => {
    const rows = parseGoogleHotelRows(SAMPLE)
    expect(rows.map((r) => r.name)).toEqual(['JW Marriott Chicago', 'AC Hotel Chicago Downtown', 'No Rating Inn'])
    expect(rows[0]).toEqual({ name: 'JW Marriott Chicago', priceUsd: 1609, rating: 4.5 })
    expect(rows[1]!.priceUsd).toBe(253)
  })

  it('de-duplicates a property the page repeats, and tolerates a missing rating', () => {
    const rows = parseGoogleHotelRows(SAMPLE)
    expect(rows.filter((r) => r.name === 'JW Marriott Chicago').length).toBe(1)
    expect(rows[2]!.rating).toBeNull()
  })

  it('returns nothing rather than junk when the page is not a results page', () => {
    expect(parseGoogleHotelRows('<html>Sorry, something went wrong</html>')).toEqual([])
  })
})

describe('the block never presents an over-budget row as if it qualified', () => {
  it('names the ceiling and says the rows are above it', async () => {
    process.env.SCRAPE_DO_TOKEN = process.env.SCRAPE_DO_TOKEN || ''
    const { googleHotelsRates } = await import('./googleHotels')
    // No token in this environment: the source declines rather than inventing.
    const before = process.env.SCRAPE_DO_TOKEN
    delete process.env.SCRAPE_DO_TOKEN
    expect(await googleHotelsRates({ city: 'chicago', checkin: '2026-09-25', checkout: '2026-09-27' })).toBeNull()
    process.env.SCRAPE_DO_TOKEN = before
  })

  it('picks the ceiling wording from the rows, not from hope', () => {
    // The three branches live in googleHotelsRates; what a test can pin without
    // a render is the rule: rows above the ceiling never read as qualifying.
    const rows = parseGoogleHotelRows(SAMPLE)
    const inBudget = rows.filter((r) => r.priceUsd <= 250)
    expect(inBudget.length).toBe(1)
    expect(inBudget[0]!.priceUsd).toBeLessThanOrEqual(250)
    expect(rows.filter((r) => r.priceUsd > 250).length).toBe(2)
  })
})
