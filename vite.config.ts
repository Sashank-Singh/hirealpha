import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { hirealphaApiPlugin } from './server/apiPlugin.ts'

const DEFAULT_SITE_URL = 'https://hirealpha.com'

/** Rewrites canonical / sitemap / OG origins from VITE_SITE_URL at build time. */
function siteUrlPlugin(): Plugin {
  const siteUrl = (process.env.VITE_SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, '')
  return {
    name: 'hirealpha-site-url',
    transformIndexHtml(html) {
      return html.replaceAll(DEFAULT_SITE_URL, siteUrl)
    },
    closeBundle() {
      if (siteUrl === DEFAULT_SITE_URL) return
      const dist = join(process.cwd(), 'dist')
      for (const name of ['robots.txt', 'sitemap.xml', 'llms.txt', 'site.webmanifest']) {
        const path = join(dist, name)
        if (!existsSync(path)) continue
        const next = readFileSync(path, 'utf8').replaceAll(DEFAULT_SITE_URL, siteUrl)
        writeFileSync(path, next)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), hirealphaApiPlugin(), siteUrlPlugin()],
  server: {
    port: 5173,
    open: false,
  },
})
