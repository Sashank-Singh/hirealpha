/**
 * The picked place's OWN website, read for the two things OpenStreetMap cannot
 * tell us: whether it is open when the user wants it, and what it costs.
 *
 * Costs nothing: the site is public, `website` comes from the same free Overpass
 * response the rows were built from, and one small model call reads the page.
 * This is the last gap in the picks dimension — hours arrived with the OSM tags,
 * prices need only the page the place already publishes.
 *
 * Guard rails, in the order they matter:
 *  - Only pages the place itself linked (no search engines, no aggregators):
 *    a menu price from a review site is not the restaurant's own published price.
 *  - One fetch per page, 6s, text only, and the page is fenced as untrusted.
 *  - The result never asserts what the page did not say. "no price found on the
 *    site" is a valid, useful answer.
 */
import { gmiChat } from '../spectrum/shared/gmi'

const FETCH_TIMEOUT_MS = Number(process.env.PLACE_SITE_TIMEOUT_MS || 6000)
/* A menu page's visible text is a few KB; 30k covers a long one without paying
 * for scripts and styles. */
const MAX_TEXT = 30_000

export type PlaceSiteFact = {
  name: string
  hours: string
  price: string
  note: string
}

/** The venue's own menu/hours page, when the homepage links one. Prices live
 * on the menu page, and the homepage is often just a hero image — measured on
 * two Chicago venues, the homepage carried facts but no prices at all. */
export function menuLinkHref(html: string, base: string): string | null {
  const links = [...String(html || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!)
  const wanted = links.find((href) => /(?:menu|our-food|food-menu|dinner|hours|contact)/i.test(href) && !/^(?:mailto:|tel:|#)/i.test(href))
  if (!wanted) return null
  try {
    return new URL(wanted, base).toString()
  } catch {
    return null
  }
}

/** The text a reader would see, with scripts, styles and tags removed. */
export function siteText(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Aggregators and social pages are not the place's own price list. */
export function isOwnSite(url: string): boolean {
  const host = (() => {
    try {
      return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      return ''
    }
  })()
  if (!host) return false
  /* Marketplaces and social pages list prices with their own markups; an
   * ordering platform the venue itself runs (Toast, Square, Clover) IS the
   * venue's published menu, so those stay. */
  return !/(?:google|yelp|tripadvisor|facebook|instagram|doordash|ubereats|grubhub|seamless|opentable|resy|zomato|menuism|allmenus|singleplatform)/.test(host)
}

type FetchOut = { name: string; url: string; text: string }

async function fetchSites(places: Array<{ name: string; site: string }>): Promise<FetchOut[]> {
  const out: FetchOut[] = []
  for (const place of places.slice(0, 3)) {
    if (!place.site || !isOwnSite(place.site)) continue
    try {
      const res = await fetch(place.site, {
        headers: {
          'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      })
      if (!res.ok) continue
      const type = (res.headers.get('content-type') || '').toLowerCase()
      if (type && !type.includes('html') && !type.includes('text')) continue
      const html = await res.text()
      let text = siteText(html).slice(0, MAX_TEXT)
      if (text.length < 200) continue
      // One page deeper for the menu/hours, because that is where prices are.
      const menuHref = menuLinkHref(html, place.site)
      if (menuHref) {
        try {
          const menuRes = await fetch(menuHref, {
            headers: { 'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)', Accept: 'text/html' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            redirect: 'follow',
          })
          if (menuRes.ok) {
            const menuText = siteText(await menuRes.text()).slice(0, MAX_TEXT)
            if (menuText.length > 200) text = `${text}\n\n[MENU PAGE ${menuHref}]\n${menuText}`
          }
        } catch {
          /* homepage facts are still worth having */
        }
      }
      out.push({ name: place.name, url: place.site, text })
    } catch {
      /* one dead site must not cost the others */
    }
  }
  return out
}

/**
 * Read up to three of the user's picks from their own sites and return one
 * line of findings per place. Empty array when nothing could be read — the
 * caller keeps its existing answer, which already says what it could not verify.
 */
export async function readPlaceSites(places: Array<{ name: string; site: string }>): Promise<PlaceSiteFact[]> {
  const fetched = await fetchSites(places)
  if (!fetched.length) return []
  const prompt = [
    'You read a restaurant or venue website and report ONLY what the page states.',
    'For each site, return one JSON object per line:',
    '{"name":"the venue","hours":"its published opening hours, or \\"\\"","price":"a concrete price signal (a dish and its price, or a menu range), or \\"\\"","note":"one short fact a visitor needs — dietary options, reservations, a caveat — or \\"\\""}',
    'Rules: never guess a price. If the page shows no price, leave price empty. If the page shows no hours, leave hours empty. Do not restate the whole menu; one representative price is what is wanted. JSON only, one object per line, no prose.',
  ].join('\n')
  const body = fetched
    .map((f) => `<UNTRUSTED_PAGE_DATA site="${f.name}">\n${f.text.slice(0, 9000)}\n</UNTRUSTED_PAGE_DATA>`)
    .join('\n\n')
  try {
    const reply = await gmiChat({
      temperature: 0.1,
      maxTokens: 700,
      reasoningEffort: 'low',
      timeoutMs: 30_000,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: body },
      ],
    })
    const facts: PlaceSiteFact[] = []
    for (const line of String(reply || '').split('\n')) {
      const start = line.indexOf('{')
      const end = line.lastIndexOf('}')
      if (start === -1 || end <= start) continue
      try {
        const parsed = JSON.parse(line.slice(start, end + 1)) as { name?: string; hours?: string; price?: string; note?: string }
        const name = String(parsed.name || '').trim()
        if (!name) continue
        // A name the model invented is useless to the caller, which matches on
        // the rows it sent.
        if (!fetched.some((f) => f.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(f.name.toLowerCase()))) continue
        facts.push({
          name,
          hours: String(parsed.hours || '').trim().slice(0, 80),
          price: String(parsed.price || '').trim().slice(0, 120),
          note: String(parsed.note || '').trim().slice(0, 120),
        })
      } catch {
        /* a malformed line costs only itself */
      }
    }
    return facts
  } catch (err) {
    console.warn('[placeSite] extraction failed', err instanceof Error ? err.message : err)
    return []
  }
}

/** The block appended under the map results, or '' when there is nothing to add. */
export function formatPlaceSiteFacts(facts: PlaceSiteFact[]): string {
  const lines = facts
    .filter((f) => f.hours || f.price || f.note)
    .map((f) => {
      const bits = [f.hours ? `hours: ${f.hours}` : '', f.price ? `price: ${f.price}` : '', f.note ? f.note : ''].filter(Boolean)
      return `- ${f.name} — ${bits.join(' | ')}`
    })
  if (!lines.length) return ''
  return [
    'From the places\' own websites just now (only what the pages state; a blank field means the site did not say):',
    ...lines,
  ].join('\n')
}
