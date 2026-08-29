/**
 * Tiny analytics channel for the marketing site.
 *
 * Fires custom funnel events into Plausible (the snippet lives in index.html)
 * so the growth loop is measurable end to end: waitlist join → checkout
 * start → share → invite used. Everything is optional and defensive — if the
 * snippet is not loaded, or the event has not been created in the dashboard,
 * this quietly does nothing and never takes the page down with it.
 *
 * Set up in Plausible: Goals → Custom events → add each event name below.
 */

type Props = Record<string, string | number | boolean>

type PlausibleWindow = Window & {
  plausible?: (event: string, opts?: { props?: Props }) => void
}

export function track(event: string, props?: Props) {
  try {
    const w = window as PlausibleWindow
    if (typeof w.plausible === 'function') {
      w.plausible(event, props ? { props } : undefined)
    }
  } catch {
    // Analytics must never break the page.
  }
}