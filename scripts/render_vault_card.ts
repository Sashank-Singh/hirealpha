import { chromium } from 'playwright'
import { resolve } from 'node:path'

async function main() {
  const htmlPath = resolve(process.cwd(), 'scripts/vault-og.html')
  const outPath = resolve(process.cwd(), 'public/images/og/vault.png')

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  })

  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    })

    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: outPath })
    console.log('Successfully saved to', outPath)
  } finally {
    await browser.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
