import { describe, expect, it } from 'bun:test'
import { formatPlaceSiteFacts, isOwnSite, siteText } from './placeSite'

describe('a place is read from its own page, never an aggregator', () => {
  /* A menu price from a review site is not the restaurant's published price. */
  it('refuses aggregators and social pages', () => {
    expect(isOwnSite('https://www.yelp.com/biz/berghoff-chicago')).toBe(false)
    expect(isOwnSite('https://www.tripadvisor.com/Restaurant_Review')).toBe(false)
    expect(isOwnSite('https://www.facebook.com/berghoff')).toBe(false)
    // A venue's own ordering platform is its published menu; marketplaces are not.
    expect(isOwnSite('https://order.toasttab.com/online/berghoff')).toBe(true)
    expect(isOwnSite('https://www.doordash.com/store/berghoff')).toBe(false)
    expect(isOwnSite('')).toBe(false)
  })

  it('accepts the venue’s own site', () => {
    expect(isOwnSite('https://theberghoff.com/menu')).toBe(true)
    expect(isOwnSite('berghoffchicago.com')).toBe(true)
  })
})

describe('page text', () => {
  it('drops scripts and styles, keeps what a reader sees', () => {
    const text = siteText('<html><head><style>body{color:red}</style><script>var x=1</script></head><body>Wienerschnitzel <b>$24</b> &amp; sides</body></html>')
    expect(text).toContain('Wienerschnitzel')
    expect(text).toContain('$24')
    expect(text).toContain('& sides')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('var x')
  })
})

describe('what the block says', () => {
  it('states only the fields the pages carried, and nothing for an empty read', () => {
    const block = formatPlaceSiteFacts([
      { name: 'The Berghoff', hours: 'Mon-Sat 11:30-21:00', price: 'Wienerschnitzel $24', note: 'vegetarian menu section' },
      { name: 'Silent Site', hours: '', price: '', note: '' },
    ])
    expect(block).toContain('The Berghoff — hours: Mon-Sat 11:30-21:00 | price: Wienerschnitzel $24')
    expect(block).not.toContain('Silent Site')
    expect(formatPlaceSiteFacts([{ name: 'Silent Site', hours: '', price: '', note: '' }])).toBe('')
  })
})
