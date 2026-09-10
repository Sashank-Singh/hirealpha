import { defineConfig } from '@playwright/test'

/**
 * Trust & navigation e2e. These tests run against a REAL deployed or staging
 * environment — they exercise live sign-in, approvals, and the workspace shell,
 * so a mock or missing environment skips them rather than faking a pass.
 *
 * Required env (all optional at collect time; tests skip without them):
 *   E2E_BASE_URL    e.g. https://staging.hirealpha.chat
 *   E2E_EMAIL       an existing test account email
 *   E2E_PASSWORD    that account's password
 */
export default defineConfig({
  testDir: './e2e',
  // .pw.ts so `bun test` never collects these (Playwright's describe throws
  // under bun:test); only the Playwright runner matches them.
  testMatch: '**/*.pw.ts',
  timeout: 60_000,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    viewport: { width: 1280, height: 900 },
  },
})
