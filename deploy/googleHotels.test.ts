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
