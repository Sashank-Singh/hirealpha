import type { SQL } from 'bun'

export interface SiteProcedure {
  steps: string[]
  workingSelectors?: Record<string, string>
  gotchas?: string[]
}

const memoryCache = new Map<string, { procedure: SiteProcedure; cachedAt: number }>()

export function extractRootDomain(urlOrHost: string): string {
  try {
    const raw = urlOrHost.startsWith('http') ? urlOrHost : `https://${urlOrHost}`
    const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
    const parts = host.split('.')
    return parts.length >= 2 ? parts.slice(-2).join('.') : host
  } catch {
    return urlOrHost.toLowerCase().trim()
  }
}

export function formatProcedureForPrompt(rootDomain: string, procedure: SiteProcedure): string {
  const lines: string[] = [`SITE MEMORY (learned from previous successful runs on ${rootDomain}):`]
  if (procedure.steps && procedure.steps.length) {
    lines.push('Recommended procedure:')
    for (const s of procedure.steps) {
      lines.push(`  - ${s}`)
    }
  }
  if (procedure.workingSelectors && Object.keys(procedure.workingSelectors).length) {
    lines.push('Known working selectors:')
    for (const [key, sel] of Object.entries(procedure.workingSelectors)) {
      lines.push(`  - ${key}: ${sel}`)
    }
  }
  if (procedure.gotchas && procedure.gotchas.length) {
    lines.push('Known gotchas & modal dismissals:')
    for (const g of procedure.gotchas) {
      lines.push(`  - ${g}`)
    }
  }
  return lines.join('\n')
}

export async function loadSiteProcedure(
  sql: SQL | null | undefined,
  urlOrDomain: string,
  category = 'general',
): Promise<SiteProcedure | null> {
  const rootDomain = extractRootDomain(urlOrDomain)
  const cacheKey = `${rootDomain}:${category}`
  const mem = memoryCache.get(cacheKey)
  if (mem && Date.now() - mem.cachedAt < 3_600_000) {
    return mem.procedure
  }

  if (!sql) return mem?.procedure || null

  try {
    const rows = (await sql`
      SELECT procedure FROM hire_site_procedures
      WHERE root_domain = ${rootDomain} AND task_category = ${category}
      LIMIT 1
    `) as Array<{ procedure: unknown }>

    if (rows[0]?.procedure) {
      const proc = rows[0].procedure as SiteProcedure
      memoryCache.set(cacheKey, { procedure: proc, cachedAt: Date.now() })
      return proc
    }
  } catch {
    // Database table might not be initialized in transient environments
  }

  return mem?.procedure || null
}

export async function saveSiteProcedure(
  sql: SQL | null | undefined,
  urlOrDomain: string,
  procedure: SiteProcedure,
  category = 'general',
): Promise<void> {
  const rootDomain = extractRootDomain(urlOrDomain)
  const cacheKey = `${rootDomain}:${category}`
  memoryCache.set(cacheKey, { procedure, cachedAt: Date.now() })

  if (!sql) return

  try {
    await sql`
      INSERT INTO hire_site_procedures (root_domain, task_category, procedure, success_count, last_verified_at, updated_at)
      VALUES (${rootDomain}, ${category}, ${JSON.stringify(procedure)}::jsonb, 1, now(), now())
      ON CONFLICT (root_domain, task_category) DO UPDATE SET
        procedure = EXCLUDED.procedure,
        success_count = hire_site_procedures.success_count + 1,
        last_verified_at = now(),
        updated_at = now()
    `
  } catch {
    // Non-fatal if table not migrated
  }
}

/**
 * Automatically distill a compact, reusable procedure from a successful action trajectory.
 */
export function synthesizeProcedureFromTrajectory(
  goal: string,
  actions: Array<{ type: string; selector?: string; value?: unknown; key?: string; label?: string }>,
): SiteProcedure {
  const steps: string[] = []
  const workingSelectors: Record<string, string> = {}
  const gotchas: string[] = []

  for (const act of actions) {
    if (act.type === 'click') {
      const label = act.label ? ` "${act.label}"` : ''
      steps.push(`Click${label}${act.selector ? ` [${act.selector}]` : ''}`)
      if (act.selector && /accept|cookie|consent|agree|close|dismiss|modal/i.test(act.selector + (act.label || ''))) {
        gotchas.push(`Dismiss consent/modal via ${act.selector}`)
      } else if (act.selector) {
        const key = act.label ? act.label.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30) : `btn_${steps.length}`
        workingSelectors[key] = act.selector
      }
    } else if (act.type === 'fill' && act.selector) {
      const summaryVal = typeof act.value === 'string' && act.value.length < 30 ? `"${act.value}"` : 'input value'
      steps.push(`Fill ${summaryVal} into ${act.selector}`)
      if (/search|query|destination|location|ss|input/i.test(act.selector)) {
        workingSelectors['search_input'] = act.selector
      }
    } else if (act.type === 'press' && act.key) {
      steps.push(`Press ${act.key}`)
    }
  }

  // Deduplicate and cap to 6 concise steps
  const uniqueSteps = Array.from(new Set(steps)).slice(0, 6)
  const uniqueGotchas = Array.from(new Set(gotchas)).slice(0, 3)

  return {
    steps: uniqueSteps,
    workingSelectors,
    gotchas: uniqueGotchas,
  }
}
