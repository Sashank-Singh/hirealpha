import {afterAll, afterEach, beforeEach, describe, expect, it} from 'bun:test'
import {
  buildOverpassQuery,
  classifyMapQuery,
  dietsFromQuery,
  fetchMapSearch,
  formatMapResults,
  geocodeMapArea,
  mapAreaFromQuery,
  PLACE_ASK_RE,
  geocodeRowUsableForTest,
} from './hire-api'

/* Maps has two paths: Overpass for category asks ("good coffee") around known
 * or geocoded coords, Nominatim for named places. These tests pin the
 * classifier, the Overpass query shape, the result formatting, and the
 * fallback from Overpass back to Nominatim. */

const savedFetch = globalThis.fetch
const savedKey = process.env.HIREALPHA_INTERNAL_KEY

beforeEach(() => {
  process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
})

afterAll(() => {
  globalThis.fetch = savedFetch
  if (savedKey === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
  else process.env.HIREALPHA_INTERNAL_KEY = savedKey
})

const fakeLocation = {
  user_id: 'u1',
  kind: 'current' as const,
  latitude: 37.77,
  longitude: -122.41,
  accuracy_m: null,
  label: '',
  source: null,
  updated_at: new Date(),
}

describe('classifyMapQuery', () => {
  it('reads a bare category ask as nearby', () => {
    expect(classifyMapQuery('good coffee')).toEqual({ mode: 'nearby', kinds: ['cafe'] })
    expect(classifyMapQuery('coffee')).toEqual({ mode: 'nearby', kinds: ['cafe'] })
    expect(classifyMapQuery('bar tonight')).toEqual({ mode: 'nearby', kinds: ['bar'] })
  })

  it('keeps the category when filler wraps it', () => {
    const out = classifyMapQuery('where should we get dinner tonight')
    expect(out.mode).toBe('nearby')
    if (out.mode === 'nearby') expect(out.kinds).toEqual(['restaurant'])
  })

  it('reads cuisine words as nearby restaurant kinds', () => {
    const out = classifyMapQuery('sushi in soma')
    expect(out.mode).toBe('nearby')
    if (out.mode === 'nearby') expect(out.kinds).toEqual(['restaurant'])
  })

  it('keeps named places out of the nearby path', () => {
    expect(classifyMapQuery('golden gate park')).toEqual({ mode: 'named' })
    expect(classifyMapQuery('hayes valley')).toEqual({ mode: 'named' })
    expect(classifyMapQuery('blue bottle coffee hayes valley')).toEqual({ mode: 'named' })
  })

  it('maps each category word to its kind set', () => {
    expect(classifyMapQuery('gym near me')).toEqual({ mode: 'nearby', kinds: ['gym'] })
    expect(classifyMapQuery('grocery run')).toEqual({ mode: 'nearby', kinds: ['grocery'] })
    const hangout = classifyMapQuery('hangout spots')
    expect(hangout.mode).toBe('nearby')
    if (hangout.mode === 'nearby') expect(hangout.kinds).toContain('park')
  })
})

describe('buildOverpassQuery', () => {
  it('builds node and way clauses around the coords', () => {
    const ql = buildOverpassQuery(['cafe'], 37.77, -122.41)
    expect(ql).toContain('[out:json][timeout:10];')
    expect(ql).toContain('node["amenity"="cafe"](around:1600,37.77,-122.41);')
    expect(ql).toContain('way["amenity"="cafe"](around:1600,37.77,-122.41);')
    expect(ql).toContain('out center 30;')
  })

  it('maps kinds to their tag sets', () => {
    expect(buildOverpassQuery(['coffee'], 0, 0)).toContain('"amenity"="cafe"')
    expect(buildOverpassQuery(['gym'], 0, 0)).toContain('"leisure"="fitness_centre"')
    expect(buildOverpassQuery(['grocery'], 0, 0)).toContain('"shop"="supermarket"')
    expect(buildOverpassQuery(['grocery'], 0, 0)).toContain('"shop"="convenience"')
    expect(buildOverpassQuery(['pharmacy'], 0, 0)).toContain('"amenity"="pharmacy"')
    expect(buildOverpassQuery(['park'], 0, 0)).toContain('"leisure"="park"')
    expect(buildOverpassQuery(['bakery'], 0, 0)).toContain('"shop"="bakery"')
    expect(buildOverpassQuery(['bar'], 0, 0)).toContain('"amenity"="pub"')
  })

  it('honors a custom radius and ignores unknown kinds', () => {
    expect(buildOverpassQuery(['cafe'], 1, 2, 800)).toContain('(around:800,1,2)')
    expect(buildOverpassQuery(['spaceship'], 1, 2)).toBe('')
  })
})

describe('formatMapResults', () => {
  const rows = [
    { name: 'Cafe A', cuisine: 'coffee', lat: 1, lon: 2 },
    { name: 'Cafe A', cuisine: 'coffee', lat: 3, lon: 4 },
    { name: 'Cafe B', lat: 5, lon: 6 },
  ]

  it('dedupes by name and caps at six', () => {
    const out = formatMapResults([...Array.from({ length: 8 }, (_, i) => ({ name: `Spot ${i}` })), ...rows], 'coffee')
    const lines = out.split('\n').filter((l) => l.startsWith('- '))
    expect(lines.length).toBe(6)
    expect(out).toContain('Map results for "coffee":')
    expect(out).not.toContain('Spot 6')
  })

  it('renders cuisine, link, and skips unnamed rows', () => {
    const out = formatMapResults([{ name: '' }, { name: 'Cafe A', cuisine: 'coffee;bakery', lat: 1, lon: 2 }], 'x')
    expect(out).toContain('- Cafe A (coffee)')
    expect(out).toContain('https://www.openstreetmap.org/?mlat=1&mlon=2#map=16/1/2')
    expect(out.split('\n').filter((l) => l.startsWith('- ')).length).toBe(1)
  })

  it('returns the no results string for empty input', () => {
    expect(formatMapResults([], 'soma')).toBe('No map results found for "soma".')
  })
})

describe('fetchMapSearch nearby path', () => {
  it('resolves a US ZIP explicitly and prioritizes it over the saved location', async () => {
    const calls: URL[] = []
    globalThis.fetch = (async input => {
      const url = new URL(String(input)); calls.push(url)
      if (url.hostname.includes('nominatim')) return Response.json([{ lat: '37.79', lon: '-122.42' }])
      return Response.json({ elements: [{ tags: { name: 'Sorella', 'addr:street': 'Polk Street', 'addr:housenumber': '1760' }, lat: 37.79, lon: -122.42 }] })
    }) as typeof fetch
    const result = await fetchMapSearch('best restaurants in 94109', 'us', fakeLocation)
    const geo = calls.find(url => url.hostname.includes('nominatim'))
    expect(geo?.searchParams.get('postalcode')).toBe('94109')
    expect(geo?.searchParams.get('countrycodes')).toBe('us')
    expect(result).toContain('1760 Polk Street')
  })
  it('uses Overpass when coords exist and formats the elements', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input)
      calls.push(url)
      if (url.includes('overpass-api.de')) {
        return new Response(
          JSON.stringify({
            elements: [
              { tags: { name: 'Ritual', cuisine: 'coffee', 'addr:street': 'Valencia St', 'addr:housenumber': '102' }, lat: 37.76, lon: -122.42 },
              { tags: { name: 'Ritual' }, lat: 37.77, lon: -122.43 },
              { tags: { 'addr:city': 'SF' }, lat: 37.78, lon: -122.44 },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('[]', { status: 200 })
    }) as typeof fetch
    const out = await fetchMapSearch('good coffee', 'us', fakeLocation)
    expect(calls.some((c) => c.includes('overpass-api.de'))).toBe(true)
    expect(out).toContain('Map results for "good coffee":')
    expect(out).toContain('- Ritual (coffee)')
    expect(out).toContain('mlat=37.76')
    expect(out.split('\n').filter((l) => l.startsWith('- ')).length).toBe(1)
  })

  it('geocodes area words through Nominatim when no coords exist', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input)
      calls.push(url)
      if (url.includes('nominatim.openstreetmap.org')) {
        return new Response(JSON.stringify([{ display_name: 'SoMa', lat: '37.77', lon: '-122.41' }]), { status: 200 })
      }
      return new Response(JSON.stringify({ elements: [{ tags: { name: 'Sushi Ran' }, lat: 37.78, lon: -122.46 }] }), { status: 200 })
    }) as typeof fetch
    const out = await fetchMapSearch('sushi in soma', 'us', null)
    expect(calls.some((c) => c.includes('nominatim.openstreetmap.org'))).toBe(true)
    expect(calls.some((c) => c.includes('overpass-api.de'))).toBe(true)
    expect(out).toContain('- Sushi Ran')
  })

  it('falls back to Nominatim named search when Overpass fails', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input)
      calls.push(url)
      if (url.includes('overpass-api.de')) return new Response('busy', { status: 504 })
      return new Response(
        JSON.stringify([{ display_name: 'Coffee Bar, SF, CA', lat: '37.76', lon: '-122.42', type: 'cafe' }]),
        { status: 200 },
      )
    }) as typeof fetch
    const out = await fetchMapSearch('good coffee', 'us', fakeLocation)
    expect(calls.filter((c) => c.includes('overpass-api.de')).length).toBe(1)
    expect(calls.some((c) => c.includes('nominatim.openstreetmap.org'))).toBe(true)
    expect(out).toContain('Map results for')
    expect(out).toContain('Coffee Bar')
  })

  it('falls back when Overpass returns no named elements', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input)
      if (url.includes('overpass-api.de')) return new Response(JSON.stringify({ elements: [] }), { status: 200 })
      return new Response(JSON.stringify([{ display_name: 'Beanery, SF', lat: '37.7', lon: '-122.4', type: 'cafe' }]), { status: 200 })
    }) as typeof fetch
    const out = await fetchMapSearch('coffee', 'us', fakeLocation)
    expect(out).toContain('Beanery')
  })

  it('keeps the named fallback when there are no coords at all', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input)
      calls.push(url)
      return new Response(JSON.stringify([{ display_name: 'Coffee Shop, Portland', lat: '45.5', lon: '-122.6', type: 'cafe' }]), { status: 200 })
    }) as typeof fetch
    const out = await fetchMapSearch('good coffee')
    expect(calls.every((c) => !c.includes('overpass-api.de'))).toBe(true)
    expect(out).toContain('Coffee Shop, Portland')
  })
})

describe('destination area without a preposition', () => {
  it('reads a named city and neighborhood from the tail of the ask', () => {
    expect(mapAreaFromQuery('vegetarian restaurant Chicago Loop')).toBe('chicago loop')
    expect(mapAreaFromQuery('dinner Chicago Loop vegetarian')).toBe('chicago loop')
    expect(mapAreaFromQuery('vegetarian restaurant near the Loop Chicago')).toBe('Loop Chicago')
    expect(mapAreaFromQuery('vegetarian restaurants in the Loop Chicago walkable')).toBe('Loop Chicago')
  })

  it('keeps the nearest-me path free of an area', () => {
    expect(mapAreaFromQuery('restaurants near me')).toBe('')
    expect(mapAreaFromQuery('good coffee')).toBe('')
  })

  it('drops leading words until a neighborhood resolves to a real place', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input)
      calls.push(url)
      // "Chicago Loop" is a residential road in North Carolina in OSM; only the
      // looser "Chicago" term is a place. The road must not be accepted.
      if (url.includes('q=Chicago+Loop') || url.includes('q=Chicago%20Loop')) {
        return new Response(JSON.stringify([{ lat: '35.40', lon: '-79.09', type: 'residential', addresstype: 'road' }]), { status: 200 })
      }
      return new Response(JSON.stringify([{ lat: '41.88', lon: '-87.62', type: 'city', addresstype: 'city' }]), { status: 200 })
    }) as typeof fetch
    const hit = await geocodeMapArea('Chicago Loop', 'us')
    expect(hit).toEqual({ lat: 41.88, lon: -87.62 })
    expect(calls.length).toBe(2)
  })

  it('surfaces diet-tagged places ahead of untagged ones, with walk times', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input)
      if (url.includes('nominatim')) {
        return new Response(JSON.stringify([{ lat: '41.881', lon: '-87.629', type: 'suburb', addresstype: 'suburb' }]), { status: 200 })
      }
      return new Response(
        JSON.stringify({
          elements: [
            { tags: { name: 'Plain Diner', amenity: 'restaurant' }, lat: 41.88, lon: -87.63 },
            { tags: { name: 'Green Table', amenity: 'restaurant', 'diet:vegetarian': 'yes' }, lat: 41.88, lon: -87.63 },
            { tags: { name: 'Corner Coffee', amenity: 'cafe', cuisine: 'coffee_shop' }, lat: 41.88, lon: -87.63 },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch
    const out = await fetchMapSearch('vegetarian restaurant Chicago Loop', 'us', null)
    expect(out).toContain('Green Table')
    expect(out).toContain('[vegetarian, confirmed]')
    expect(out).toContain('min walk')
    // The vegetarian tag is what the ask was about, so it sorts first.
    expect(out.indexOf('Green Table')).toBeLessThan(out.indexOf('Plain Diner'))
    // A coffee shop is not dinner.
    expect(out).not.toContain('Corner Coffee')
  })

  it('treats a hotel as a nearby kind so a landmark anchors the search', () => {
    // "Find hotels near the Burj Khalifa" was classified as a named-place
    // lookup before hotels were a kind: it answered from one Nominatim hit and
    // the reply padded the gap with unrelated hotels.com links.
    expect(classifyMapQuery('Find hotels near the Burj Khalifa')).toMatchObject({ mode: 'nearby' })
    expect(mapAreaFromQuery('Find hotels near the Burj Khalifa')).toBe('Burj Khalifa')
    expect(classifyMapQuery('find me a hostel in Lisbon').mode).toBe('nearby')
  })

  it('does not let a booking verb decide the kind', () => {
    // The leading word used to choose: "book a hotel in Chicago Loop" read
    // "book" as the kind and fell through to the named path.
    expect(classifyMapQuery('book a hotel in Chicago Loop')).toMatchObject({ mode: 'nearby' })
    expect(mapAreaFromQuery('book a hotel in Chicago Loop')).toBe('Chicago Loop')
  })

  it('geocodes a landmark, not just a city', () => {
    // Nominatim labels the Empire State Building `office`. A whitelist of place
    // types rejected it, so the whole ask reported no hotels at all.
    expect(geocodeRowUsableForTest({ lat: '40.748', lon: '-73.985', addresstype: 'office' })).toBe(true)
    expect(geocodeRowUsableForTest({ lat: '35.40', lon: '-79.09', addresstype: 'road' })).toBe(false)
    expect(geocodeRowUsableForTest({ lat: '41.88', lon: '-87.62', addresstype: 'suburb' })).toBe(true)
  })

  it('recognises "hotels near X" as a place ask', () => {
    // The pattern missed the "near" form, so verified map data was ignored and
    // the reply fell back to whatever a web search returned.
    expect(PLACE_ASK_RE.test('Find hotels near the Empire State Building')).toBe(true)
    expect(PLACE_ASK_RE.test('any good cafe in Lisbon')).toBe(true)
    expect(PLACE_ASK_RE.test('remember for good: no pork')).toBe(false)
    expect(PLACE_ASK_RE.test('what time is my flight')).toBe(false)
  })

  it('reads diet words into their OSM tags', () => {
    expect(dietsFromQuery('vegan dinner in Chicago')).toEqual(['diet:vegan=yes'])
    expect(dietsFromQuery('halal cart near the Loop')).toEqual(['diet:halal=yes'])
    expect(dietsFromQuery('dinner for four')).toEqual([])
  })
})

describe('fetchMapSearch named path', () => {
  it('still geocodes a specific venue via Nominatim', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input)
      calls.push(url)
      return new Response(
        JSON.stringify([{ display_name: 'Golden Gate Park, SF', lat: '37.77', lon: '-122.51', type: 'park' }]),
        { status: 200 },
      )
    }) as typeof fetch
    const out = await fetchMapSearch('golden gate park')
    expect(calls.every((c) => !c.includes('overpass-api.de'))).toBe(true)
    expect(out).toContain('Golden Gate Park, SF')
    expect(out).toContain('(park)')
  })

  it('routes hotel searches to LangSearch webSearchContext for rich details', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input)
      if (url.includes('api.langsearch.com')) {
        return new Response(
          JSON.stringify({
            data: {
              webPages: {
                value: [
                  {
                    name: 'The Palmer House Hilton - Loop Chicago',
                    url: 'https://www.hilton.com/palmer-house',
                    summary: 'Historic hotel in Chicago Loop with rooms from $195/night and free cancellation up to 24 hours prior.',
                  },
                ],
              },
            },
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify([]), { status: 404 })
    }) as typeof fetch
    const out = await fetchMapSearch('hotels in Chicago Loop under $250')
    expect(out).toContain('The Palmer House Hilton')
    expect(out).toContain('$195/night')
  })
})

