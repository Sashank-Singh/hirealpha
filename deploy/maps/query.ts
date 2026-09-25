import { PLACE_ASK_RE } from "../../spectrum/shared/toolLoop"

export const FOREIGN_PLACE = /\b(bali|jakarta|thailand|indonesia|london|paris|tokyo|kyoto|athens|rome|madrid|berlin|amsterdam|sydney|melbourne|mumbai|delhi|bangkok|marrakech|dubai|singapore|hong\s?kong|europe|asia|africa|mexico city|canada|australia|india|france|italy|spain|germany|brazil|argentina|colombia|philippines|panama|uk|england|scotland|ireland)\b/i

export function timezoneCountry(tz?: string) {
  if (!tz) return ''
  if (/^America\//.test(tz)) return 'us'
  if (tz === 'Europe/London' || tz === 'UTC') return 'gb'
  return ''
}

// A category ask ("good coffee") has no proper noun to geocode. Words map to
// kinds, kinds to the Overpass tags that can match them.
export const MAP_WORD_KINDS: Record<string, string[]> = {
  cafe: ['cafe'],
  coffee: ['cafe'],
  restaurant: ['restaurant'],
  dinner: ['restaurant'],
  supper: ['restaurant'],
  lunch: ['restaurant', 'cafe'],
  breakfast: ['cafe', 'restaurant'],
  brunch: ['cafe', 'restaurant'],
  food: ['restaurant', 'cafe', 'fast_food'],
  eat: ['restaurant', 'cafe', 'fast_food'],
  bar: ['bar'],
  bars: ['bar'],
  drink: ['bar'],
  drinks: ['bar'],
  pub: ['bar'],
  bakery: ['bakery'],
  bakeries: ['bakery'],
  fast_food: ['fast_food'],
  ice_cream: ['ice_cream'],
  sushi: ['restaurant'],
  ramen: ['restaurant'],
  pizza: ['restaurant'],
  burger: ['restaurant'],
  tacos: ['restaurant'],
  mexican: ['restaurant'],
  thai: ['restaurant'],
  vietnamese: ['restaurant'],
  chinese: ['restaurant'],
  japanese: ['restaurant'],
  korean: ['restaurant'],
  indian: ['restaurant'],
  italian: ['restaurant'],
  pasta: ['restaurant'],
  noodles: ['restaurant'],
  bbq: ['restaurant'],
  seafood: ['restaurant'],
  deli: ['restaurant'],
  diner: ['restaurant'],
  gym: ['gym'],
  gyms: ['gym'],
  hotel: ['hotel'],
  hotels: ['hotel'],
  hostel: ['hostel'],
  hostels: ['hostel'],
  lodging: ['hotel', 'guest_house'],
  stay: ['hotel', 'guest_house', 'hostel'],
  fitness: ['gym'],
  grocery: ['grocery'],
  groceries: ['grocery'],
  supermarket: ['grocery'],
  pharmacy: ['pharmacy'],
  pharmacies: ['pharmacy'],
  drugstore: ['pharmacy'],
  park: ['park'],
  parks: ['park'],
  hangout: ['cafe', 'bar', 'park'],
}

export const MAP_KIND_TAGS: Record<string, string[]> = {
  cafe: ['amenity=cafe'],
  restaurant: ['amenity=restaurant'],
  bar: ['amenity=bar', 'amenity=pub'],
  bakery: ['shop=bakery'],
  fast_food: ['amenity=fast_food'],
  ice_cream: ['amenity=ice_cream'],
  gym: ['leisure=fitness_centre', 'amenity=gym'],
  grocery: ['shop=supermarket', 'shop=convenience'],
  pharmacy: ['amenity=pharmacy'],
  park: ['leisure=park'],
  hotel: ['tourism=hotel'],
  hostel: ['tourism=hostel'],
  guest_house: ['tourism=guest_house'],
}

// Words that describe the ask rather than name the place. They trail the
// place as often as they lead it, so both ends are stripped before geocoding.
const MAP_DESCRIPTOR_WORDS = new Set([
  'walkable', 'walking', 'nearby', 'close', 'near', 'cheap', 'affordable', 'nice', 'good',
  'best', 'great', 'local', 'vegetarian', 'vegan', 'veggie', 'romantic', 'quiet', 'casual',
  'chain', 'options', 'option', 'spots', 'spot', 'places', 'place', 'list',
])

export const MAP_FILLER_WORDS = new Set([
  'find', 'show', 'recommend', 'where', 'should', 'could', 'can', 'would', 'get', 'grab',
  // Booking verbs are the ask, not the kind: the leading "book" in "book a hotel
  // in Chicago Loop" used to decide the whole query was a named place.
  'book', 'booking', 'reserve', 'reservation', 'order', 'search', 'need', 'want',
  'want', 'need', 'some', 'any', 'good', 'best', 'great', 'cheap', 'quiet', 'nice', 'cozy',
  'cute', 'cool', 'fun', 'top', 'open', 'late', 'tonight', 'today', 'now', 'nearby', 'near',
  'around', 'in', 'at', 'by', 'me', 'us', 'we', 'i', 'my', 'our', 'a', 'an', 'the', 'for',
  'to', 'of', 'and', 'please', 'place', 'places', 'spot', 'spots', 'maps', 'map',
])

// Diet/quality qualifiers before the kind word ("vegetarian restaurants in
// the Chicago Loop") are skipped so the kind still routes to a nearby
// search; without this the whole phrase fell through to a geocode miss.
/* "walking distance from my hotel" names the reference point, not the kind of
 * place being asked for — without this, a dinner ask returned hotels alongside
 * restaurants and its area resolved to nothing. */
const MAP_REFERENCE_POINT =
  /\b(?:from|near|next to|beside|by|at)\s+(?:my|our|the|your)\s+(?:hotel|hostel|airbnb|apartment|bnb|place|office|desk|room)\b/g

const MAP_QUALIFIER_WORDS = new Set([
  'vegetarian', 'vegan', 'halal', 'kosher', 'gluten', 'healthy', 'cheap', 'good', 'best',
  'nice', 'quiet', 'fancy', 'romantic', 'top', 'family', 'great', 'solid', 'late', 'open',
])

/* Words that describe the kind of place rather than name one. "vegetarian
 * friendly non chain" is three constraints in a row, and the head token used to
 * land on "friendly": the lookup failed, the query was read as a landmark, and
 * the whole dining ask went to a web search that answered with a 2008 blog
 * instead of a nearby search around the Loop. */
const MAP_CONSTRAINT_WORDS = new Set([
  'friendly', 'non', 'chain', 'nonchain', 'independent', 'local', 'authentic', 'popular',
  'busy', 'hidden', 'walking', 'walkable', 'distance', 'from', 'my', 'our', 'your',
  'under', 'over', 'budget', 'reasonable', 'affordable', 'upscale', 'casual', 'midtown',
  'downtown', 'uptown', 'area', 'district', 'neighborhood', 'nearby', 'around',
])

/**
 * A turn that wants a place found ("hotels near the Empire State Building",
 * "dinner near the Loop"). "near" belongs in the link word: without it the
 * phrase matched nothing, so a verified map result was ignored and the reply
 * fell back to whatever a web search returned — booking-site homepages.
 * Exported so the engine and the maps tool agree on what a place ask is.
 */
export { PLACE_ASK_RE }

export function classifyMapQuery(query: string): { mode: 'nearby'; kinds: string[] } | { mode: 'named' } {
  const normalized = query
    .toLowerCase()
    .replace(MAP_REFERENCE_POINT, ' ')
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bfast food\b/g, ' fast_food ')
    .replace(/\bice cream\b/g, ' ice_cream ')
    .replace(/\s+/g, ' ')
    .trim()
  const lookup = (token: string) =>
    MAP_WORD_KINDS[token] || (token.endsWith('s') ? MAP_WORD_KINDS[token.slice(0, -1)] : undefined)
  const tokens = normalized.split(' ').filter((t) => t && !MAP_FILLER_WORDS.has(t))
  let head = 0
  const isKind = (token: string | undefined) => Boolean(token && lookup(token))
  while (head < tokens.length - 1 && (MAP_QUALIFIER_WORDS.has(tokens[head] ?? '') || MAP_CONSTRAINT_WORDS.has(tokens[head] ?? ''))) head++
  // Leading word decides: "golden gate park" is a place, "park near me" is not.
  // A sentence of constraints before the kind is still a nearby search, so when
  // the head is not a kind, accept the first kind within a few tokens provided
  // every token in front of it is a constraint word — nothing that could be
  // part of a place name.
  if (!isKind(tokens[head])) {
    const kindIdx = tokens.slice(0, 7).findIndex((t) => isKind(t))
    const headIsName = kindIdx > 0 && tokens.slice(0, kindIdx).every((t) => MAP_CONSTRAINT_WORDS.has(t) || MAP_QUALIFIER_WORDS.has(t))
    if (headIsName) head = kindIdx
    else return { mode: 'named' }
  }
  const kinds: string[] = []
  for (const token of tokens) {
    for (const kind of lookup(token) || []) {
      if (!kinds.includes(kind)) kinds.push(kind)
    }
  }
  return { mode: 'nearby', kinds }
}

/**
 * The area a nearby search should actually run around.
 *
 * "near/in <place>" is the explicit form, but people also name the
 * destination without a preposition ("vegetarian restaurant Chicago Loop",
 * "hotels downtown Chicago"). Those turns used to fall back to the user's
 * saved location and search the wrong city — a Chicago ask answered with
 * San Francisco blocks. The trailing city-like token is the fallback.
 */
export function mapAreaFromQuery(query: string): string {
  const explicit = (query.match(/\b(?:in|near|around|at|by)\s+([a-z0-9\s]+)$/i)?.[1] || query.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || '')
    .replace(/\b(?:me|us|tonight)\b/gi, '')
    .split(/\s+/)
    .filter(
      (word) =>
        word &&
        !MAP_FILLER_WORDS.has(word.toLowerCase()) &&
        !MAP_QUALIFIER_WORDS.has(word.toLowerCase()) &&
        !MAP_DESCRIPTOR_WORDS.has(word.toLowerCase()),
    )
    .join(' ')
    .trim()
  if (explicit && !/^(?:me|us|here)$/i.test(explicit)) return explicit
  // No preposition: treat the words after the last kind word as the place.
  // "vegetarian restaurant chicago loop" -> "chicago loop"; the geocoder tries
  // the full phrase first and then progressively drops leading words, so a
  // neighborhood the geocoder does not know still lands on its city.
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
  const kindIdx = words.findLastIndex(
    (word) =>
      Boolean(MAP_WORD_KINDS[word]) ||
      Boolean(MAP_WORD_KINDS[word.endsWith('s') ? word.slice(0, -1) : word]),
  )
  if (kindIdx === -1) return ''
  // Descriptor words trail the place as often as they precede it ("walkable
  // from Loop Chicago"), and leaving them in made the whole phrase fail to
  // geocode — a Chicago ask then answered from the user's home city.
  const tail = words
    .slice(kindIdx + 1)
    .filter(
      (word) =>
        word &&
        !MAP_FILLER_WORDS.has(word) &&
        !MAP_QUALIFIER_WORDS.has(word) &&
        !MAP_DESCRIPTOR_WORDS.has(word),
    )
    .join(' ')
    .trim()
  return /[a-z]/.test(tail) ? tail : ''
}

/**
 * Every area worth trying for a nearby search, best first.
 *
 * The single-area extractor keys off the LAST kind word, which breaks on a
 * sentence that names two: "vegetarian-friendly independent restaurants near
 * the Loop, Chicago, open for dinner Saturday, walking distance from downtown
 * hotels" ends on "hotels", so the area came back empty, the user's home city
 * was used instead (or nothing at all), and the search degraded to a web lookup
 * that answered with a Las Vegas buffet review.
 *
 * Candidates, in order: the stretch right after the FIRST kind word, the tail
 * after the last one, the explicit "near X" phrase, then the whole sentence.
 * The caller geocodes them in order and takes the first that resolves.
 */
/** Drop the numbers, months, weekdays and constraint words an ask carries, so
 * a city search gets a city: "loop chicago sep 25 sep 27 250 night" → "loop
 * chicago". A dated benchmark ask read "chicago friday saturday next week
 * under 250 night loop with free cancellation", and that whole sentence went to
 * the hotel search as the location. */
export function mapPlaceWords(area: string): string {
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const shorts = months.map((m) => m.slice(0, 3))
  return String(area || '')
    .replace(/\b\d{1,4}\b/g, ' ')
    .replace(new RegExp(`\\b(?:${months.join('|')}|${shorts.join('|')})\\b`, 'gi'), ' ')
    .replace(
      /\b(?:nights?|nightly|under|over|below|above|budget|per|a|each|for|to|from|and|stay|staying|rooms?|free|cancellation|cancel|refundable|with|next|this|week|weekend|sun|mon|tue|tues|wed|thu|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
      ' ',
    )
    .replace(/[^a-z0-9\s,]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The hard constraints a hotel ask stated: the nightly ceiling, whether free
 * cancellation is required, and how far out is acceptable when the ask named a
 * neighborhood rather than a city. The looked-up rates are filtered by these
 * before the model ever sees them — a search that ignores "under $250/night"
 * or "free cancellation" reads as a non-answer against the scored task.
 */
export function hotelConstraintsFromAsk(query: string): {
  maxPricePerNight: number | null
  freeCancellation: boolean
  maxDistanceKm: number | null
} {
  const text = String(query || '')
  const named =
    /\b(?:under|below|less than|no more than|max(?:imum)?|up to|cheaper than|budget(?: of)?)\s*\$?\s*(\d{2,4})\b/i.exec(text) ||
    /\$\s*(\d{2,4})\b/.exec(text)
  const raw = named ? Number(named[1]) : NaN
  // A "for 4 nights" ask carries numbers too; a bare 3-4 digit figure followed
  // by a night word is the nightly ceiling, everything else is only trusted
  // when it sits next to a dollar sign or a budget word (the regex above).
  const maxPricePerNight = Number.isFinite(raw) && raw >= 30 && raw <= 10_000 ? raw : null
  const freeCancellation = /\b(?:free|flexible|full)\s+cancel(?:lation)?\b|\bcancel(?:lation)?\s+(?:is\s+)?free\b|\brefundable\b/i.test(text)
  const maxDistanceKm = /walk(?:ing|able)?\s+distance|walkable|\bnear\s+the\b|\bnear\b|\bdowntown\b|\bthe loop\b/i.test(text) ? 5 : null
  return { maxPricePerNight, freeCancellation, maxDistanceKm }
}

export function mapAreaCandidates(query: string): string[] {
  const clean = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(
        (word) =>
          word &&
          !MAP_FILLER_WORDS.has(word) &&
          !MAP_QUALIFIER_WORDS.has(word) &&
          !MAP_CONSTRAINT_WORDS.has(word) &&
          !MAP_DESCRIPTOR_WORDS.has(word) &&
          !MAP_WORD_KINDS[word] &&
          !MAP_WORD_KINDS[word.endsWith('s') ? word.slice(0, -1) : word],
      )
      .join(' ')
      .trim()

  const stripped = query.replace(MAP_REFERENCE_POINT, ' ')
  const words = clean(stripped).split(' ').filter(Boolean)
  const raw = stripped
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
  const isKind = (word: string) => Boolean(MAP_WORD_KINDS[word]) || Boolean(MAP_WORD_KINDS[word.endsWith('s') ? word.slice(0, -1) : word])
  const first = raw.findIndex(isKind)
  const last = raw.findLastIndex(isKind)

  const candidates: string[] = []
  if (first !== -1) {
    // Between the first kind word and the next one: "restaurants NEAR THE LOOP
    // CHICAGO open for dinner ... downtown hotels" keeps the real area and drops
    // the trailing clause.
    const next = raw.findIndex((w, i) => i > first && isKind(w))
    const between = clean(raw.slice(first + 1, next === -1 ? undefined : next).join(' '))
    if (between) candidates.push(between)
  }
  if (last !== -1 && last !== first) {
    const tail = clean(raw.slice(last + 1).join(' '))
    if (tail) candidates.push(tail)
  }
  const explicit = mapAreaFromQuery(query)
  if (explicit) candidates.push(explicit)
  const whole = words.join(' ').trim()
  if (whole && whole !== explicit) candidates.push(whole)
  return [...new Set(candidates)].filter((c) => /[a-z]/.test(c))
}

/** Diet words in the ask, mapped to the OpenStreetMap tag that records them. */
const MAP_DIET_TAGS: Record<string, string> = {
  vegetarian: 'diet:vegetarian=yes',
  vegan: 'diet:vegan=yes',
  halal: 'diet:halal=yes',
  kosher: 'diet:kosher=yes',
  'gluten-free': 'diet:gluten_free=yes',
  'gluten free': 'diet:gluten_free=yes',
  'glutenfree': 'diet:gluten_free=yes',
}

export function dietsFromQuery(query: string): string[] {
  const lower = query.toLowerCase()
  const hits: string[] = []
  for (const [word, tag] of Object.entries(MAP_DIET_TAGS)) {
    if (new RegExp(`\\b${word.replace(/[-\s]/g, '[-\\s]?')}\\b`, 'i').test(lower) && !hits.includes(tag)) {
      hits.push(tag)
    }
  }
  return hits
}
