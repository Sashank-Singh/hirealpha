import { describe, expect, it } from 'bun:test'
import { appendSessionTokenToProxyAssets } from './routes/browser'

const JOB = '0f7a82cb-98b8-4efe-82b2-348a1965befb'
const PREFIX = `/api/computer/live-proxy/${JOB}`
const TOKEN = '1789628907.10dea6c097c6b9f8ea8302198550a45a52eb556da33523b7652e069463d904c7'

describe('live-proxy asset tokens', () => {
  it('appends the session token to an asset that already carries a jwt', () => {
    const html = `<script src="${PREFIX}/browser/live/js/app.416afd11.js?jwt=abc.def"></script>`
    const out = appendSessionTokenToProxyAssets(html, PREFIX, TOKEN)
    expect(out).toContain(`?jwt=abc.def&token=${TOKEN}`)
  })

  it('uses ? when the asset has no query string', () => {
    const html = `<link href="${PREFIX}/browser/live/css/app.css">`
    const out = appendSessionTokenToProxyAssets(html, PREFIX, TOKEN)
    expect(out).toContain(`href="${PREFIX}/browser/live/css/app.css?token=${TOKEN}"`)
  })

  it('leaves the base href alone so relative resolution is unchanged', () => {
    const html = `<head><base href="${PREFIX}/">`
    const out = appendSessionTokenToProxyAssets(html, PREFIX, TOKEN)
    expect(out).toBe(html)
  })

  it('rewrites single-quoted and escaped-quote URLs too', () => {
    const html = `const a='${PREFIX}/browser/live/js/x.js'; const b=\\"${PREFIX}/browser/live/js/y.js\\";`
    const out = appendSessionTokenToProxyAssets(html, PREFIX, TOKEN)
    expect(out).toContain(`'${PREFIX}/browser/live/js/x.js?token=${TOKEN}'`)
    expect(out).toContain(`\\"${PREFIX}/browser/live/js/y.js?token=${TOKEN}\\"`)
  })

  it('never touches another job’s assets', () => {
    const other = `/api/computer/live-proxy/11111111-2222-3333-4444-555555555555/browser/live/js/app.js`
    const html = `<script src="${other}"></script>`
    expect(appendSessionTokenToProxyAssets(html, PREFIX, TOKEN)).toBe(html)
  })

  it('returns the html untouched when there is no token', () => {
    const html = `<script src="${PREFIX}/browser/live/js/app.js"></script>`
    expect(appendSessionTokenToProxyAssets(html, PREFIX, '')).toBe(html)
  })
})
