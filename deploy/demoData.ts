import type { SQL } from 'bun'
import {
  demoToolkitData,
  toolkitForDemoSlug,
  demoLinearIssues,
  type DemoToolkit,
} from './demoFixtures'

/**
 * Demo mode: one fixed, fully seeded fake account so the coworker and
 * cofounder homes, mini-apps, and bot turns can be exercised end to end
 * without a real person connecting Gmail, Slack, Linear, or Stripe.
 *
 * Rules the whole module enforces:
 * - The demo identity is a single fixed user id compared exactly. Every
 *   connector read branches on it before anything else; no real user row is
 *   ever consulted or written by demo code.
 * - Connector reads go through the same parsers and formatters as real
 *   Composio responses (see demoFixtures.ts), so the demo exercises the real
 *   endpoints and data shapes instead of a parallel mock path.
 * - Writes never fake success: an unmocked slug behaves like a failed read,
 *   and the send/Linear-write guards in hire-api refuse for the demo user.
 * - Seeding is idempotent, versioned, and never queues an intro — nothing
 *   here may cause a bot to text anybody.
 */

export const DEMO_USER_ID = 'hire-alpha-demo-user'
export const DEMO_EMAIL = 'demo@hirealpha.chat'
export const DEMO_PHONE = '+15550100100'
export const DEMO_NAME = 'Sashank'
export const DEMO_TIMEZONE = 'America/Los_Angeles'

/** Bump when the seed story changes materially so existing rows refresh. */
export const DEMO_SEED_VERSION = 1

/** Connector ids as the rest of the API sees them (UI ids, pre-deny filter). */
export const DEMO_CONNECTED: readonly string[] = [
  'gmail',
  'calendar',
  'drive',
  'slack',
  'notion',
  'linear',
  'github',
  'figma',
  'stripe',
  'plaid',
  'quickbooks',
  'hubspot',
  'intercom',
  'salesforce',
  'jira',
  'sentry',
  'zoom',
]

/** The same set as Composio toolkit slugs, for composioConnected() surfaces. */
export const DEMO_COMPOSIO_TOOLKITS: readonly string[] = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'slack',
  'notion',
  'linear',
  'github',
  'figma',
  'stripe',
  'plaid',
  'quickbooks',
  'hubspot',
  'intercom',
  'salesforce',
  'jira',
  'sentry',
  'zoom',
]

export const isDemoUserId = (id: string | null | undefined) => id === DEMO_USER_ID
export const isDemoEmail = (email: string | null | undefined) =>
  !!email && email.trim().toLowerCase() === DEMO_EMAIL
export const isDemoPhone = (phone: string | null | undefined) => {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits.length >= 10 && DEMO_PHONE.replace(/\D/g, '').endsWith(digits.slice(-10))
}

/** Demo mode is opt-in; unset (the default everywhere in prod) means no demo rows, no demo routes. */
export const demoModeEnabled = () => process.env.DEMO_MODE === '1'

/**
 * The Composio-shaped answer for a demo user's tool read, or null when this
 * is not a demo call or the slug is not mocked. hire-api's composioExecute /
 * composioExecuteData call this before touching the real client.
 */
export function demoComposioData(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  now: Date = new Date(),
): unknown | null {
  if (!isDemoUserId(userId)) return null
  const toolkit: DemoToolkit | null = toolkitForDemoSlug(tool)
  if (!toolkit) return null
  return demoToolkitData(toolkit, tool, args, now)
}

/** The demo Linear board in the shape listLinearIssues returns. */
export function demoLinearIssuesForUser(userId: string, now: Date = new Date()) {
  if (!isDemoUserId(userId)) return { issues: [], needConnect: false }
  const issues = demoLinearIssues(now).nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    state: typeof n.state === 'object' ? n.state.name : n.state,
    team: typeof n.team === 'object' ? n.team.name : n.team,
  }))
  return { issues, needConnect: false }
}

/* ---------------- Seeding ---------------- */

const dayStr = (d: Date, tz = DEMO_TIMEZONE) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

const hoursAgoIso = (now: Date, hours: number) => new Date(now.getTime() + hours * 3600_000).toISOString()
const daysAgoIso = (now: Date, days: number) => hoursAgoIso(now, days * 24)

export interface DemoSeedResult {
  seeded: boolean
  errors: string[]
}

/**
 * Create or refresh the demo workspace. Idempotent: fixed row ids with ON
 * CONFLICT DO NOTHING mean re-running converges. Each group is isolated so a
 * schema drift degrades to a partial demo instead of a failed boot.
 *
 * Deliberately NOT here: hire_subscriptions (nothing fake ever looks paid),
 * hire_intro_queue (no bot may text the demo phone), hire_google_tokens
 * (the demo has no Google account — reads fall through to the Composio path,
 * which is where the mock data lives).
 */
export async function seedDemoWorkspace(sql: SQL, now: Date = new Date()): Promise<DemoSeedResult> {
  const errors: string[] = []
  const step = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const today = dayStr(now)
  const yesterday = dayStr(new Date(now.getTime() - 24 * 3600_000))

  await step('user', async () => {
    await sql`
      INSERT INTO hire_users (id, email, name, timezone, phone_e164)
      VALUES (${DEMO_USER_ID}, ${DEMO_EMAIL}, ${DEMO_NAME}, ${DEMO_TIMEZONE}, ${DEMO_PHONE})
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, timezone = excluded.timezone
    `
  })

  await step('roster', async () => {
    for (const persona of ['friend', 'coworker', 'cofounder']) {
      await sql`
        INSERT INTO hire_roster (user_id, persona, hired_at)
        VALUES (${DEMO_USER_ID}, ${persona}, now() - interval '30 days')
        ON CONFLICT (user_id, persona) DO NOTHING
      `
    }
  })

  await step('context', async () => {
    const rows: Array<{ persona: string; fields: Record<string, unknown> }> = [
      {
        persona: 'friend',
        fields: { name: DEMO_NAME, timezone: DEMO_TIMEZONE, location: 'San Francisco, CA' },
      },
      {
        persona: 'coworker',
        fields: {
          company: 'Northwind Labs',
          role: 'Founder / CEO',
          team: 'Nine people, eng heavy. Priya and Jordan are the senior engs, Maya runs design.',
          standup_style: 'Terse. Yesterday, today, blocked. No polish.',
        },
      },
      {
        persona: 'cofounder',
        fields: {
          venture: 'Northwind Labs',
          focus: 'Webhook reliability first, then expand from dev tools into full observability.',
          cash: '412000',
          burn: '34000',
          hiring_bar: 'Owned a quota or an owned system. No passengers.',
        },
      },
    ]
    for (const row of rows) {
      await sql`
        INSERT INTO hire_context (user_id, persona, fields)
        VALUES (${DEMO_USER_ID}, ${row.persona}, ${JSON.stringify(row.fields)}::jsonb)
        ON CONFLICT (user_id, persona) DO UPDATE SET fields = excluded.fields, updated_at = now()
      `
    }
  })

  await step('memories', async () => {
    const rows: Array<{ persona: string; key: string; value: string }> = [
      { persona: 'coworker', key: 'preferred_name', value: 'Sashank' },
      { persona: 'coworker', key: 'company', value: 'Northwind Labs' },
      { persona: 'coworker', key: 'team_norms', value: 'Deploy freeze Fridays 5pm. Standup notes go out in chat, not a doc.' },
      { persona: 'cofounder', key: 'preferred_name', value: 'Sashank' },
      { persona: 'cofounder', key: 'north_star', value: 'Webhook reliability first, then observability expansion.' },
      { persona: 'cofounder', key: 'investors', value: 'Harbor Ventures (intro pending). Northswan passed at seed.' },
      { persona: 'friend', key: 'preferred_name', value: 'Sashank' },
      { persona: 'friend', key: 'timezone', value: DEMO_TIMEZONE },
    ]
    for (const row of rows) {
      await sql`
        INSERT INTO hire_memories (user_id, persona, key, value, durable)
        VALUES (${DEMO_USER_ID}, ${row.persona}, ${row.key}, ${row.value}, true)
        ON CONFLICT (user_id, persona, key) DO UPDATE SET value = excluded.value, updated_at = now()
      `
    }
  })

  await step('standups', async () => {
    const notes = [
      {
        day: yesterday,
        text: 'Yesterday: shipped the billing export to four customers. Landed the retry cap fix in review. Today: Acme pricing call, Harbor intro prep. Blocked: onboarding modal visuals on Maya.',
      },
      {
        day: today,
        text: 'Yesterday: billing export shipped. Today: Acme pricing call at 2, Harbor intro blurb. Blocked: NW-477 modal visuals on Maya.',
      },
    ]
    for (const row of notes) {
      await sql`
        INSERT INTO hire_standups (id, user_id, day, notes)
        VALUES (${'demo-standup-' + row.day}, ${DEMO_USER_ID}, ${row.day}, ${row.text})
        ON CONFLICT (user_id, day) DO UPDATE SET notes = excluded.notes
      `
    }
  })

  await step('drafts', async () => {
    const drafts = [
      {
        id: 'demo-draft-acme-quote',
        persona: 'coworker',
        kind: 'email',
        to: 'dana@acmecorp.com',
        subject: 'Re: platform pilot — quote with SSO seats',
        body:
          'Dana,\n\nQuote attached with the 15% held through Friday and the 40 SSO seats added. If legal signs as-is we can start Monday.\n\nSashank',
      },
      {
        id: 'demo-draft-standup',
        persona: 'coworker',
        kind: 'email',
        to: 'team@northwind-labs.com',
        subject: 'Standup notes',
        body:
          'Yesterday: billing export shipped to four customers. Today: Acme pricing call, Harbor blurb. Blocked: NW-477 on Maya for the modal frames.',
      },
      {
        id: 'demo-draft-investor-note',
        persona: 'cofounder',
        kind: 'investor',
        to: 'sam@northwind-labs.com',
        subject: 'Northwind monthly — pipeline holding',
        body:
          'Sam,\n\nPipeline is holding: $69k open across three pilots, Acme at contract. Cash $412k against $34k monthly burn, about 12 months. The ask this month is warm intros to dev-tools funds for the A.\n\nSashank',
      },
    ]
    for (const d of drafts) {
      await sql`
        INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body, status)
        VALUES (${d.id}, ${DEMO_USER_ID}, ${d.persona}, ${d.kind}, ${d.to}, ${d.subject}, ${d.body}, 'pending')
        ON CONFLICT (id) DO NOTHING
      `
    }
  })

  await step('loops', async () => {
    const loops = [
      { id: 'demo-loop-acme-seats', title: 'Confirm Acme seat count with legal', context: 'Acme legal said 40 seats; the quote needs the SSO tier before Friday.', dueHours: -20 },
      { id: 'demo-loop-harbor-blurb', title: 'Send Sam the three line Harbor blurb', context: 'Sam Rivera will forward it to Harbor Ventures this week.', dueHours: 6 },
      { id: 'demo-loop-board-deck', title: 'Update the board deck with September numbers', context: 'Pipeline, runway, and the webhook reliability win rate.', dueHours: 48 },
      { id: 'demo-loop-soc2-vendors', title: 'Finish SOC2 vendor questionnaire responses', context: 'Kate Lin at Vertex needs it before the Thursday security review.', dueHours: 96 },
    ]
    for (const loop of loops) {
      await sql`
        INSERT INTO hire_loops (id, user_id, persona, title, context, due_at, status)
        VALUES (${loop.id}, ${DEMO_USER_ID}, 'coworker', ${loop.title}, ${loop.context},
                ${hoursAgoIso(now, loop.dueHours)}::timestamptz, 'open')
        ON CONFLICT (id) DO NOTHING
      `
    }
  })

  await step('pipeline', async () => {
    const deals = [
      { id: 'demo-pipe-acme', title: 'Acme Corp — platform', company: 'Acme Corp', stage: 'offer', value: 48000, days: -1, notes: 'Contract sent with the 15% held through Friday. HubSpot deal demo-hs-1.' },
      { id: 'demo-pipe-vertex', title: 'Vertex Data — pilot', company: 'Vertex Data', stage: 'interview', value: 12000, days: -2, notes: 'Kickoff done; success criteria doc due Wednesday. HubSpot deal demo-hs-2.' },
      { id: 'demo-pipe-brightline', title: 'Brightline — rollout', company: 'Brightline', stage: 'active', value: 9000, days: -6, notes: 'Two teams in the eval. HubSpot deal demo-hs-3.' },
      { id: 'demo-pipe-harbor', title: 'Harbor Ventures — intro call', company: 'Harbor Ventures', stage: 'lead', value: 0, days: -3, notes: 'Intro from Sam Rivera. First conversation, narrative only. HubSpot deal demo-hs-4.' },
      { id: 'demo-pipe-fieldstone', title: 'Fieldstone — eval', company: 'Fieldstone', stage: 'lead', value: 6000, days: -34, notes: 'No touch in a month. HubSpot deal demo-hs-5.' },
      { id: 'demo-pipe-fernwick', title: 'Fernwick — pilot', company: 'Fernwick', stage: 'active', value: 7200, days: -12, notes: 'Waiting on their security review.' },
      { id: 'demo-pipe-garrison', title: 'Garrison Labs — annual', company: 'Garrison Labs', stage: 'won', value: 24000, days: -8, notes: 'Signed at the annual rate.' },
      { id: 'demo-pipe-quill', title: 'Quill — pilot', company: 'Quill', stage: 'lost', value: 5000, days: -20, notes: 'Went with an all-in-one suite.' },
    ]
    for (const d of deals) {
      await sql`
        INSERT INTO hire_pipeline (id, user_id, title, company, stage, value, notes, created_at, updated_at)
        VALUES (${d.id}, ${DEMO_USER_ID}, ${d.title}, ${d.company}, ${d.stage}, ${d.value}, ${d.notes},
                ${daysAgoIso(now, d.days - 20)}::timestamptz, ${daysAgoIso(now, d.days)}::timestamptz)
        ON CONFLICT (id) DO NOTHING
      `
    }
  })

  await step('decisions', async () => {
    const decisions = [
      {
        id: 'demo-dec-ae-first',
        persona: 'cofounder',
        decision: 'Hire a senior AE before any VP of Sales',
        reason: 'Conversion stalls without an owned pipeline, not lead volume',
        evidence: '9 of 14 open deals stuck more than 21 days in proposal or later',
        owner: 'Sashank',
        reviewHours: -48,
        status: 'open',
        outcome: null as string | null,
      },
      {
        id: 'demo-dec-android',
        persona: 'cofounder',
        decision: 'Shelve the Android beta until iMessage retention clears 40%',
        reason: 'Split eng focus across two platforms at nine people',
        evidence: 'Week 4 retention: 22% iOS vs 9% Android',
        owner: 'Sashank',
        reviewHours: -24,
        status: 'open',
        outcome: null,
      },
      {
        id: 'demo-dec-connect-first',
        persona: 'cofounder',
        decision: 'Move onboarding to connect-first',
        reason: 'Connected users convert to paid far more often',
        evidence: 'Onboarding revamp one pager in Notion',
        owner: 'Priya',
        reviewHours: 168,
        status: 'resolved',
        outcome: 'Shipped. Activation up 2.3x for connected users.',
      },
      {
        id: 'demo-dec-pricing',
        persona: 'coworker',
        decision: 'Hold the 15% pilot discount for Acme through Friday',
        reason: 'Legal cleared the DPA; the discount unblocks the Monday start',
        evidence: 'Dana email, three days ago',
        owner: 'Sashank',
        reviewHours: 96,
        status: 'open',
        outcome: null,
      },
    ]
    for (const d of decisions) {
      await sql`
        INSERT INTO hire_decisions (id, user_id, persona, decision, reason, evidence, owner, review_at, outcome, status)
        VALUES (${d.id}, ${DEMO_USER_ID}, ${d.persona}, ${d.decision}, ${d.reason}, ${d.evidence}, ${d.owner},
                ${hoursAgoIso(now, d.reviewHours)}::timestamptz, ${d.outcome}, ${d.status})
        ON CONFLICT (id) DO NOTHING
      `
    }
  })

  await step('network', async () => {
    const people = [
      { id: 'demo-net-dana', name: 'Dana Okafor', where: 'Acme pilot', context: 'Champion at Acme. Legal cleared the DPA; wants the discount held.', cadence: 7, touch: -9 },
      { id: 'demo-net-sam', name: 'Sam Rivera', where: 'Intro to Harbor Ventures', context: 'Angel. Offering a warm intro to Harbor this week.', cadence: 14, touch: -3 },
      { id: 'demo-net-marcus', name: 'Marcus Webb', where: 'Vertex Data kickoff', context: 'Vertex champion. Sending success criteria by Wednesday.', cadence: 7, touch: -4 },
      { id: 'demo-net-kate', name: 'Kate Lin', where: 'Vertex security review', context: 'Needs the SOC2 vendor responses before Thursday.', cadence: 14, touch: -27 },
    ]
    for (const p of people) {
      await sql`
        INSERT INTO hire_network (id, user_id, name, where_met, context, last_touch, cadence_days, phone)
        VALUES (${p.id}, ${DEMO_USER_ID}, ${p.name}, ${p.where}, ${p.context},
                ${daysAgoIso(now, p.touch)}::timestamptz, ${p.cadence}, '')
        ON CONFLICT (id) DO NOTHING
      `
    }
  })

  await step('runway', async () => {
    await sql`
      INSERT INTO hire_runway_snapshots (id, user_id, taken_on, cash, burn, months)
      VALUES (${'demo-runway-' + today}, ${DEMO_USER_ID}, ${today}, 412000, 34000, 12.1)
      ON CONFLICT (user_id, taken_on) DO UPDATE SET cash = excluded.cash, burn = excluded.burn, months = excluded.months
    `
  })

  await step('spending', async () => {
    const spends = [
      { id: 'demo-spend-payroll', amount: 35500, category: 'other', description: 'Payroll (semimonthly)', days: -2 },
      { id: 'demo-spend-aws', amount: 2140, category: 'other', description: 'AWS', days: -3 },
      { id: 'demo-spend-gmi', amount: 890, category: 'subscriptions', description: 'GMI inference', days: -3 },
      { id: 'demo-spend-saas', amount: 340, category: 'subscriptions', description: 'Linear, Slack, Sentry seats', days: -4 },
      { id: 'demo-spend-coffee', amount: 60, category: 'food', description: 'Team lunch', days: -1 },
    ]
    for (const s of spends) {
      await sql`
        INSERT INTO hire_spending (id, user_id, amount, category, description, spent_at)
        VALUES (${s.id}, ${DEMO_USER_ID}, ${s.amount}, ${s.category}, ${s.description}, ${daysAgoIso(now, s.days)}::timestamptz)
        ON CONFLICT (id) DO NOTHING
      `
    }
    await sql`
      INSERT INTO hire_spending_budget (user_id, weekly_budget)
      VALUES (${DEMO_USER_ID}, 45000)
      ON CONFLICT (user_id) DO NOTHING
    `
  })

  await step('weekly review', async () => {
    const lastWeekStart = dayStr(new Date(now.getTime() - ((now.getUTCDay() + 6) % 7) * 86400_000 - 7 * 86400_000))
    await sql`
      INSERT INTO hire_weekly_reviews (id, user_id, week_start, done_text, slipped_text, focus_text)
      VALUES ('demo-review-last', ${DEMO_USER_ID}, ${lastWeekStart},
        'Billing export shipped. Retry cap fix in review. Acme to contract stage.',
        'SOC2 vendor questionnaire slipped again.',
        'Close Acme, keep the deploy freeze from eating the week.')
      ON CONFLICT (id) DO NOTHING
    `
  })

  if (errors.length) {
    console.warn('[demo] partial seed:', errors.join(' | '))
  }
  return { seeded: errors.length === 0, errors }
}
