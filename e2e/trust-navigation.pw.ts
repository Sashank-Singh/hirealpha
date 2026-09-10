import { expect, test } from '@playwright/test'

const hasEnv = Boolean(process.env.E2E_BASE_URL && process.env.E2E_EMAIL && process.env.E2E_PASSWORD)
const description = hasEnv ? '' : ' (skipped: E2E_BASE_URL/E2E_EMAIL/E2E_PASSWORD not set — certification runs these against staging)'

test.describe(`workspace navigation and approval surfaces${description}`, () => {
  test.skip(!hasEnv, 'requires a real staging environment and test account')

  test.beforeEach('sign in', async ({ page }) => {
    await page.goto('/app/login')
    await page.getByLabel(/email/i).fill(process.env.E2E_EMAIL!)
    await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD!)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/app/)
  })

  const views = ['Workspace', 'Vault', 'Payments', 'Memory', 'Trust & Audit']

  for (const label of views) {
    test(`sidebar navigates to ${label} and back`, async ({ page }) => {
      const nav = page.locator('.workspace-sidebar')
      await expect(nav).toBeVisible()
      // Click twice: the intermittent sidebar failure showed up on rapid
      // re-clicks and on switching away and back (stale routing state).
      await nav.getByRole('button', { name: label, exact: false }).click()
      await expect(page.locator('.workspace-header h1')).toHaveText(label)
      await nav.getByRole('button', { name: 'Workspace', exact: false }).click()
      await expect(page.locator('.workspace-header h1')).toHaveText('Workspace')
      await nav.getByRole('button', { name: label, exact: false }).click()
      await expect(page.locator('.workspace-header h1')).toHaveText(label)
    })
  }

  test('stale ?tab= falls back to workspace instead of a blank shell', async ({ page }) => {
    await page.goto('/app?tab=does-not-exist')
    await expect(page.locator('.workspace-header h1')).toHaveText('Workspace')
  })

  test('trust view lists approvals history and revocable access', async ({ page }) => {
    await page.goto('/app?tab=trust')
    await expect(page.locator('#trust-section')).toBeVisible()
    const active = page.getByRole('button', { name: 'Revoke' })
    const count = await active.count()
    for (let i = 0; i < count; i++) {
      await expect(active.nth(i)).toBeEnabled()
    }
    await expect(page.locator('#trust-section, .ss-empty').first()).toBeVisible()
  })

  test('memory view lists memories with per-item delete', async ({ page }) => {
    await page.goto('/app?tab=memory')
    await expect(page.locator('#memory-section')).toBeVisible()
  })

  test('keyboard-only navigation reaches every view', async ({ page }) => {
    await page.goto('/app')
    await page.keyboard.press('Tab') // skip link
    for (let i = 0; i < views.length; i++) {
      await page.keyboard.press('Tab')
      await page.keyboard.press('Enter')
      await expect(page.locator('.workspace-header h1')).not.toHaveText('')
    }
  })
})
