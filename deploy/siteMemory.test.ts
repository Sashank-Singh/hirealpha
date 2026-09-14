import { describe, expect, it } from 'bun:test'
import {
  extractRootDomain,
  formatProcedureForPrompt,
  synthesizeProcedureFromTrajectory,
  loadSiteProcedure,
  saveSiteProcedure,
  type SiteProcedure,
} from './siteMemory'

describe('siteMemory', () => {
  it('extracts root domain correctly', () => {
    expect(extractRootDomain('https://www.booking.com/searchresults.html')).toBe('booking.com')
    expect(extractRootDomain('https://campusnet.csuohio.edu/index.jsp')).toBe('csuohio.edu')
    expect(extractRootDomain('amazon.co.uk')).toBe('co.uk')
    expect(extractRootDomain('amazon.com')).toBe('amazon.com')
  })

  it('formats procedure cleanly for model prompt', () => {
    const proc: SiteProcedure = {
      steps: ['Click "Search"', 'Select check-in date'],
      workingSelectors: { search_input: 'input[name="ss"]' },
      gotchas: ['Dismiss consent popup via button#accept'],
    }
    const text = formatProcedureForPrompt('booking.com', proc)
    expect(text).toContain('SITE MEMORY (learned from previous successful runs on booking.com):')
    expect(text).toContain('Click "Search"')
    expect(text).toContain('search_input: input[name="ss"]')
    expect(text).toContain('Dismiss consent popup via button#accept')
  })

  it('synthesizes concise procedure from trajectory', () => {
    const trajectory = [
      { type: 'click', selector: 'button#onetrust-accept-btn-handler', label: 'Accept' },
      { type: 'fill', selector: 'input[name="ss"]', value: 'Chicago' },
      { type: 'press', key: 'Enter' },
      { type: 'click', selector: 'button[type="submit"]', label: 'Search' },
    ]
    const proc = synthesizeProcedureFromTrajectory('Find hotel in Chicago', trajectory)
    expect(proc.steps.length).toBeGreaterThanOrEqual(3)
    expect(proc.workingSelectors?.['search_input']).toBe('input[name="ss"]')
    expect(proc.gotchas?.[0]).toContain('button#onetrust-accept-btn-handler')
    // The httpbin incident: procedures used to store literal values, so a
    // demo person's details replayed onto the next run. Values must never
    // appear in a synthesized procedure.
    const serialized = JSON.stringify(proc)
    expect(serialized).not.toContain('Chicago')
    expect(proc.steps.some((s) => s.includes("user's own value"))).toBe(true)
  })

  it('saves and loads from in-memory cache without requiring postgres', async () => {
    const proc: SiteProcedure = {
      steps: ['Step A', 'Step B'],
    }
    await saveSiteProcedure(null, 'https://testsite.com/foo', proc)
    const loaded = await loadSiteProcedure(null, 'https://sub.testsite.com/bar')
    expect(loaded).not.toBeNull()
    expect(loaded?.steps).toEqual(['Step A', 'Step B'])
  })
})
