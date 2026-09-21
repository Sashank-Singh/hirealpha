import { describe, expect, it } from 'bun:test'
import { parsePlaceHits, placeLookupUrl, placeSearchUrl, shortPlaceLabel } from './placeSearch'

/* What Nominatim jsonv2 actually returns for the address in the founder's
 * screenshot — lat/lon as STRINGS, a long display_name, and (on some rows) no
 * coordinates at all. */
const ROWS = [
  {
    lat: '37.7896585',
    lon: '-122.4276674',
    display_name: '1353 Bush Street, Nob Hill, San Francisco, California, 94109, United States',
  },
  {
    lat: '37.7749295',
    lon: '-122.4194155',
    display_name: 'San Francisco, California, United States',
  },
  // A row with no coordinates is not a place you can save.
  { display_name: 'Bush Street, Chicago, Illinois, United States' },
]

describe('place suggestions', () => {
  it('does not query for a fragment too short to mean anything', () => {
    expect(placeSearchUrl('')).toBeNull()
    expect(placeSearchUrl('sf')).toBeNull()
    expect(placeSearchUrl('1353 Bush')).toContain('nominatim.openstreetmap.org/search')
  })

  it('builds a type-ahead query, not a single-result lookup', () => {
    const url = placeSearchUrl('1353 Bush Street San Francisco')
    expect(url).toContain('format=jsonv2')
    expect(url).toContain('limit=5')
    expect(url).toContain('q=1353+Bush+Street+San+Francisco')
    // The save path asks for exactly one, which is what makes it the fallback.
    expect(placeLookupUrl('1353 Bush Street')).toContain('limit=1')
  })

  it('reads string coordinates, and drops rows without them', () => {
    const hits = parsePlaceHits(ROWS)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ lat: 37.7896585, lon: -122.4276674 })
    expect(hits[0]!.label).toBe('1353 Bush Street, Nob Hill, San Francisco, California')
    expect(hits[1]!.label).toBe('San Francisco, California')
  })

  it('keeps the full name for disambiguation and a short one for the input', () => {
    const [hit] = parsePlaceHits(ROWS)
    expect(hit!.display).toContain('94109, United States')
    expect(hit!.label).not.toContain('United States')
  })

  /* The founder's own address, as the live endpoint really returns it: the
   * building name first, and the city nowhere near the front. Head-truncating
   * this produced "Music City, 1353;1355, Bush Street, Polk Gulch" — the address
   * he typed with San Francisco gone. */
  it('follows the words the person typed instead of the source\'s own ordering', () => {
    const live = [{
      lat: '37.7885268',
      lon: '-122.4195056',
      display_name: 'Music City, 1353;1355, Bush Street, Polk Gulch, San Francisco, California, 94109, United States',
    }]
    const label = parsePlaceHits(live, 5, '1353 Bush Street San Francisco, 94109')[0]!.label
    expect(label).toContain('Bush Street')
    expect(label).toContain('San Francisco')
    expect(label).not.toContain('Music City')
    expect(label).not.toContain('United States')
    // A bare city query keeps the city-shaped answer.
    expect(parsePlaceHits(live, 5, 'san francisco')[0]!.label).toContain('San Francisco')
    // No query at all still produces something usable rather than an empty label.
    expect(parsePlaceHits(live)[0]!.label.length).toBeGreaterThan(0)
  })

  it('caps the list and survives junk', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ lat: '1', lon: '2', display_name: `Place ${i}, CA` }))
    expect(parsePlaceHits(many)).toHaveLength(5)
    expect(parsePlaceHits(many, 2)).toHaveLength(2)
    expect(parsePlaceHits(null)).toEqual([])
    expect(parsePlaceHits('nope')).toEqual([])
    // Out-of-range coordinates are not a place.
    expect(parsePlaceHits([{ lat: '999', lon: '2', display_name: 'Nowhere' }])).toEqual([])
  })

  it('shortens labels without losing the city, and never overflows the box', () => {
    expect(shortPlaceLabel('San Francisco, California, United States')).toBe('San Francisco, California')
    expect(shortPlaceLabel('')).toBe('')
    const long = shortPlaceLabel('Some Extremely Long Venue Name That Goes On, And On, And On, District, City, State, 94109, United States')
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long.startsWith('Some Extremely Long Venue Name')).toBe(true)
  })
})
