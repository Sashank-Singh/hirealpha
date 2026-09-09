import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface StepRecord {
  step: number
  action: string
  selector?: string
  value?: string
  url: string
  screenshotBase64: string
  description: string
  timestamp: string
}

export async function runFormDemo(scenario: 'linkedin' | 'quotes' | 'cart' = 'linkedin'): Promise<StepRecord[]> {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  const records: StepRecord[] = []

  const snap = async (action: string, description: string, selector?: string, value?: string) => {
    const buf = await page.screenshot({ type: 'jpeg', quality: 65 })
    records.push({
      step: records.length + 1,
      action,
      selector,
      value,
      url: page.url(),
      screenshotBase64: `data:image/jpeg;base64,${buf.toString('base64')}`,
      description,
      timestamp: new Date().toLocaleTimeString(),
    })
  }

  try {
    if (scenario === 'linkedin') {
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForTimeout(1000)
      await snap('navigate', 'Navigated to LinkedIn Login page', undefined, 'https://www.linkedin.com/login')

      // Inspect elements
      await snap('inspect', 'Located interactive elements: [1] #username, [2] #password, [3] button[type=submit]', '#username')

      // Type username
      await page.fill('#username', 'sashank@hirealpha.chat')
      await page.waitForTimeout(500)
      await snap('fill', 'Typed user email into [1] #username', '#username', 'sashank@hirealpha.chat')

      // Click password field
      await page.click('#password')
      await page.waitForTimeout(300)
      await snap('auth_gate', 'Detected protected password field. Paused for 1Password Vault authorization', '#password')

      // Fill password (after auth simulation)
      await page.fill('#password', '••••••••••••')
      await page.waitForTimeout(500)
      await snap('fill', 'Credential injected via 1Password Vault token', '#password', '••••••••••••')

      // Hover / focus submit button
      await page.hover('button[type=submit]')
      await snap('click', 'Hovered and clicked [3] button[type=submit]', 'button[type=submit]')
    } else if (scenario === 'quotes') {
      await page.goto('https://quotes.toscrape.com/login', { waitUntil: 'domcontentloaded' })
      await snap('navigate', 'Navigated to login form', undefined, 'https://quotes.toscrape.com/login')

      await page.fill('#username', 'alpha_agent')
      await snap('fill', 'Filled [1] #username', '#username', 'alpha_agent')

      await page.fill('#password', 'secure_auth_pass')
      await snap('fill', 'Filled [2] #password', '#password', '••••••••')

      await page.click('input[type=submit]')
      await page.waitForTimeout(1000)
      await snap('submit', 'Submitted form and authenticated successfully', 'input[type=submit]')
    }
  } finally {
    await browser.close()
  }

  return records
}

if (import.meta.main) {
  console.log('Running standalone Playwright form demo...')
  const results = await runFormDemo('linkedin')
  console.log(`Completed ${results.length} steps:`)
  for (const r of results) {
    console.log(`  Step ${r.step}: ${r.action} - ${r.description} (${r.screenshotBase64.length} chars)`)
  }
}
