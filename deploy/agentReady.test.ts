import { describe, expect, it } from 'bun:test'
import {
  isKnownClientRoute,
  isKnownPage,
  markdownFor,
  notFoundMarkdown,
  PAGE_FILES,
  PERSONAS,
  PUBLIC_INFO,
  wantsMarkdown,
} from './agentReady'

describe('agent readiness routing', () => {
  it('owns only the real SPA routes', () => {
    expect(isKnownClientRoute('/')).toBe(true)
    expect(isKnownClientRoute('/app')).toBe(true)
    expect(isKnownClientRoute('/app/mini/friend/home')).toBe(true)
    expect(isKnownClientRoute('/app/login')).toBe(true)
    // Unknown paths must 404, not soft-404 with the shell.
    expect(isKnownClientRoute('/some-path-that-does-not-exist')).toBe(false)
    expect(isKnownClientRoute('/wp-admin')).toBe(false)
    expect(isKnownClientRoute('/about')).toBe(false) // a static page, not the SPA
  })

  it('maps the trust/portal pages to files', () => {
    for (const p of ['/about', '/contact', '/privacy', '/developers', '/docs']) {
      expect(isKnownPage(p)).toBe(true)
      expect(PAGE_FILES[p]).toEndWith('.html')
    }
    expect(isKnownPage('/nope')).toBe(false)
  })

  it('negotiates markdown only when asked', () => {
    expect(wantsMarkdown('text/markdown')).toBe(true)
    expect(wantsMarkdown('text/html,application/xhtml+xml,text/markdown;q=0.9')).toBe(true)
    expect(wantsMarkdown('text/html')).toBe(false)
    expect(wantsMarkdown(null)).toBe(false)
    expect(wantsMarkdown('*/*')).toBe(false)
  })

  it('has markdown for the home and every known page', () => {
    expect(markdownFor('/')).toContain('# HireAlpha')
    for (const p of Object.keys(PAGE_FILES)) {
      expect(markdownFor(p)).toBeTruthy()
    }
    expect(markdownFor('/nope')).toBeNull()
  })

  it('404 body points agents at the sitemap and llms.txt', () => {
    const body = notFoundMarkdown('/whatever')
    expect(body).toContain('404')
    expect(body).toContain('/sitemap.xml')
    expect(body).toContain('/llms.txt')
  })

  it('exposes public info and the three personas', () => {
    expect(PUBLIC_INFO.pricing.perPersonaMonthlyUsd).toBe(19)
    expect(PERSONAS.map((p) => p.id)).toEqual(['friend', 'coworker', 'cofounder'])
  })
})
