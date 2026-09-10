/** Startup validation for provider-backed surfaces. Missing variables are
 * reported, never invented — certification treats a missing variable as
 * BLOCKED, not as a pass. */
export type Surface = 'web' | 'worker' | 'openbao' | 'e2b' | 'stripe' | 'certification'

const REQUIREMENTS: Record<Surface, string[]> = {
  web: ['DATABASE_URL'],
  worker: ['DATABASE_URL'],
  openbao: ['OPENBAO_ADDR', 'OPENBAO_TOKEN'],
  e2b: ['E2B_API_KEY', 'E2B_BROWSER_TEMPLATE'],
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  certification: ['CERT_ALLOW_LIVE', 'CERT_DATABASE_URL'],
}

export function validateEnvironment(
  surface: Surface,
  env: Record<string, string | undefined> = process.env,
): { ok: boolean; missing: string[] } {
  const missing = REQUIREMENTS[surface].filter((key) => !env[key]?.trim())
  return { ok: missing.length === 0, missing }
}
