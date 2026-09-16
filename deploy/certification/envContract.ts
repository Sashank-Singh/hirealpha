/** Startup validation for provider-backed surfaces. Missing variables are
 * reported, never invented — certification treats a missing variable as
 * BLOCKED, not as a pass. */
export type Surface = 'web' | 'worker' | 'kernel-worker' | 'openbao' | 'e2b' | 'stripe' | 'certification'

const REQUIREMENTS: Record<Surface, string[]> = {
  web: ['DATABASE_URL'],
  worker: ['DATABASE_URL'],
  'kernel-worker': ['DATABASE_URL', 'KERNEL_API_KEY', 'GMI_API_KEY', 'OPENBAO_ADDR', 'OPENBAO_TOKEN'],
  openbao: ['OPENBAO_ADDR', 'OPENBAO_TOKEN'],
  e2b: ['E2B_API_KEY', 'E2B_BROWSER_TEMPLATE'],
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  certification: ['CERT_ALLOW_LIVE', 'CERT_DATABASE_URL'],
}

/** Deployment gate for the production Kernel + Browser Use path. Secrets are
 * never returned; only missing or unsafe configuration names are reported. */
export function validateProductionBrowserWorker(
  env: Record<string, string | undefined> = process.env,
): { ok: boolean; problems: string[] } {
  const problems = validateEnvironment('kernel-worker', env).missing.map((key) => `missing:${key}`)
  const disabled = (name: string) => ['0', 'false', 'off'].includes((env[name] || '').trim().toLowerCase())
  if (disabled('HIREALPHA_TASK_RECORD')) problems.push('unsafe:HIREALPHA_TASK_RECORD')
  if (disabled('HIREALPHA_RECEIPT_GATE')) problems.push('unsafe:HIREALPHA_RECEIPT_GATE')
  if ((env.KERNEL_AGENT_DRIVER || 'browser-use').trim().toLowerCase() !== 'browser-use') problems.push('unsafe:KERNEL_AGENT_DRIVER')
  if (['0', 'false', 'off'].includes((env.KERNEL_TELEMETRY || 'true').trim().toLowerCase())) problems.push('unsafe:KERNEL_TELEMETRY')
  try {
    const app = new URL(env.HIREALPHA_APP_URL || '')
    if (app.protocol !== 'https:') problems.push('unsafe:HIREALPHA_APP_URL')
  } catch {
    problems.push('missing:HIREALPHA_APP_URL')
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)].sort() }
}

export function validateEnvironment(
  surface: Surface,
  env: Record<string, string | undefined> = process.env,
): { ok: boolean; missing: string[] } {
  const missing = REQUIREMENTS[surface].filter((key) => !env[key]?.trim())
  return { ok: missing.length === 0, missing }
}
