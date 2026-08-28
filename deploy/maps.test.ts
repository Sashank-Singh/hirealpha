import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildOverpassQuery, classifyMapQuery, fetchMapSearch, formatMapResults } from './hire-api'

/* Maps has two paths: Overpass for category asks ("good coffee") around known
 * or geocoded coords, Nominatim for named places. These tests pin the
 * classifier, the Overpass query shape, the result formatting, and the
 * fallback from Overpass back to Nominatim. */

const savedFetch = globalThis.fetch
const savedKey = process.env.HIREALPHA_INTERNAL_KEY

beforeEach(() => {
  process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
})

afterEach(() => {
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
})
