/**
 * Demo workspace fixtures: the fake data a demo user's connectors "return".
 *
 * Every payload is shaped exactly like the real Composio tool response so the
 * production parsers (walkLinearIssues, parseComposioMailItems,
 * parseComposioCalendarData, formatComposioData) work on it unchanged — if a
 * parser changes, the demo breaks loudly instead of silently lying.
 *
 * Everything is generated relative to a `now` argument so a demo opened any
 * day reads like today: fresh standups, meetings later today, PRs from an
 * hour ago. Same `now` in, same bytes out — tests pin determinism.
 *
 * The story: Northwind Labs, a nine person dev-tools startup. The demo user
 * is its founder, so the coworker persona has an eng team (Linear, Slack,
 * GitHub) to work and the cofounder persona has a pipeline and a raise
 * (HubSpot, Stripe, investor email) to argue about.
 */

export type DemoToolkit =
  | 'gmail'
  | 'googlecalendar'
  | 'googledrive'
  | 'slack'
  | 'linear'
  | 'notion'
  | 'github'
  | 'figma'
  | 'stripe'
  | 'plaid'
  | 'quickbooks'
  | 'intercom'
  | 'salesforce'
  | 'hubspot'
  | 'jira'
  | 'sentry'
  | 'zoom'

/** Tool slug prefix → toolkit, same rule as toolkitForToolSlug in hire-api. */
export function toolkitForDemoSlug(tool: string): DemoToolkit | null {
  const m = /^(GMAIL|GOOGLECALENDAR|GOOGLEDRIVE|SLACK|LINEAR|NOTION|GITHUB|FIGMA|STRIPE|PLAID|QUICKBOOKS|INTERCOM|SALESFORCE|HUBSPOT|JIRA|SENTRY|ZOOM)_/.exec(
    tool,
  )
  if (!m) return null
  const name = m[1]
  if (name === 'GOOGLECALENDAR') return 'googlecalendar'
  if (name === 'GOOGLEDRIVE') return 'googledrive'
  return name.toLowerCase() as DemoToolkit
}

const hoursAgoIso = (now: Date, hours: number) => new Date(now.getTime() + hours * 3600_000).toISOString()
const daysAgoIso = (now: Date, days: number) => hoursAgoIso(now, days * 24)
const unixSeconds = (now: Date, hours: number) => Math.floor((now.getTime() + hours * 3600_000) / 1000)
const inMinutesIso = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString()

/* ---------------- Gmail ---------------- */

export function demoGmail(now: Date) {
  return {
    messages: [
      {
        messageId: 'demo-mail-acme-pricing',
        sender: 'Dana Okafor <dana@acmecorp.com>',
        subject: 'Re: platform pilot — pricing',
        messageTimestamp: unixSeconds(now, -3),
        snippet: 'Legal is fine with the DPA. Can you hold the 15% pilot discount through Friday?',
        messageText:
          'Legal is fine with the DPA as written. Two asks: hold the 15% pilot discount through Friday so we can sign, and add the SSO seat tier to the quote. If both land we can start the pilot Monday.',
      },
      {
        messageId: 'demo-mail-jordan-flake',
        sender: 'Jordan Lee <jordan@northwind-labs.com>',
        subject: 'Staging flake reproduces on main',
        messageTimestamp: unixSeconds(now, -2),
        snippet: 'It was the fixture, not the app. PR up, but the deploy freeze complicates it.',
        messageText:
          'The webhook retry flake reproduces on main with the seeded fixture, so it was the fixture, not the app. Fix is up as PR 342 but the deploy freeze complicates landing it before Friday.',
      },
      {
        messageId: 'demo-mail-priya-specs',
        sender: 'Priya Raman <priya@northwind-labs.com>',
        subject: 'Modal specs ready for review',
        messageTimestamp: unixSeconds(now, -5),
        snippet: 'Blocked on the Figma frame, but the copy and states are all there.',
        messageText:
          'Modal specs are ready for review — copy and error states are all there. I am still blocked on the fourth Figma frame from Maya, so visual review will have to wait for that.',
      },
      {
        messageId: 'demo-mail-harbor-intro',
        sender: 'Sam Rivera <sam@northwind-labs.com>',
        subject: 'Investor intro: Harbor Ventures',
        messageTimestamp: unixSeconds(now, -26),
        snippet: 'Happy to intro you to Harbor. Send me a three line blurb.',
        messageText:
          'Happy to intro you to Harbor Ventures. Send me a three line blurb I can forward and I will make the connection this week. They led a dev-tools seed last quarter so the timing is good.',
      },
      {
        messageId: 'demo-mail-vertex-security',
        sender: 'Kate Lin <kate@vertexdata.io>',
        subject: 'Security questionnaire',
        messageTimestamp: unixSeconds(now, -27),
        snippet: 'Attached the SOC2 questions. Mostly vendor management.',
        messageText:
          'Attached the SOC2 questions. Most of it is vendor management and subprocessors. We need this back before the security review call on Thursday.',
      },
      {
        messageId: 'demo-mail-marcus-kickoff',
        sender: 'Marcus Webb <marcus@vertexdata.io>',
        subject: 'Pilot kickoff follow up',
        messageTimestamp: unixSeconds(now, -30),
        snippet: 'Great session. Sending the success criteria doc by Wednesday.',
        messageText:
          'Great kickoff session. I will send the success criteria doc by Wednesday so we can baseline before the pilot starts.',
      },
      {
        messageId: 'demo-mail-stripe-receipt',
        sender: 'Stripe <receipts@stripe.com>',
        subject: 'Your payout from Northwind Labs is on the way',
        messageTimestamp: unixSeconds(now, -20),
        snippet: 'Your payout of $12,480.00 is scheduled to arrive in your bank account.',
        messageText: 'Your payout of $12,480.00 is scheduled to arrive in your bank account in 2 business days.',
      },
    ],
  }
}

/* ---------------- Google Calendar ---------------- */

export function demoCalendar(now: Date) {
  return {
    items: [
      {
        summary: 'Eng standup',
        start: { dateTime: inMinutesIso(now, 45) },
        end: { dateTime: inMinutesIso(now, 60) },
        description: 'Northwind Labs eng team, daily.',
      },
      {
        summary: 'Meeting with Dana Okafor at Acme',
        start: { dateTime: inMinutesIso(now, 175) },
        end: { dateTime: inMinutesIso(now, 220) },
        hangoutLink: 'https://meet.google.com/nwd-acme',
        description: 'Pilot pricing. Legal cleared the DPA; she wants the discount held through Friday.',
      },
      {
        summary: 'Investor call — Harbor Ventures',
        start: { dateTime: inMinutesIso(now, 360) },
        end: { dateTime: inMinutesIso(now, 390) },
        description: 'Intro from Sam Rivera. First conversation, narrative only.',
      },
      {
        summary: 'Board deck review',
        start: { dateTime: inMinutesIso(now, 1560) },
        end: { dateTime: inMinutesIso(now, 1680) },
        description: 'September numbers before the board meeting.',
      },
    ],
  }
}

/* ---------------- Linear ---------------- */

export function demoLinearIssues(now: Date) {
  return {
    nodes: [
      {
        id: 'demo-lin-481',
        identifier: 'NW-481',
        title: 'Urgent: webhook retries drop events after 3 attempts',
        state: { name: 'In Progress' },
        team: { name: 'Eng' },
        priorityLabel: 'Urgent',
        assignee: { name: 'Priya Raman' },
        updatedAt: hoursAgoIso(now, -4),
        comments: [{ body: 'Still seeing drops on staging. The fixture fix is in review.', createdAt: hoursAgoIso(now, -2) }],
      },
      {
        id: 'demo-lin-477',
        identifier: 'NW-477',
        title: 'Onboarding modal specs',
        state: { name: 'In Progress' },
        team: { name: 'Product' },
        priorityLabel: 'High',
        assignee: { name: 'Priya Raman' },
        updatedAt: hoursAgoIso(now, -5),
        comments: [{ body: 'Blocked on Figma frame 4 from Maya. Copy and states are done.', createdAt: hoursAgoIso(now, -6) }],
      },
      {
        id: 'demo-lin-468',
        identifier: 'NW-468',
        title: 'Billing export CSV for enterprise customers',
        state: { name: 'In Review' },
        team: { name: 'Eng' },
        priorityLabel: 'Normal',
        assignee: { name: 'Jordan Lee' },
        updatedAt: hoursAgoIso(now, -20),
        comments: [{ body: 'PR 341 open, needs a second reviewer.', createdAt: hoursAgoIso(now, -20) }],
      },
      {
        id: 'demo-lin-455',
        identifier: 'NW-455',
        title: 'SSO seat tier in the quote flow',
        state: { name: 'Todo' },
        team: { name: 'Product' },
        priorityLabel: 'High',
        assignee: { name: 'Unassigned' },
        updatedAt: daysAgoIso(now, -2),
        comments: [{ body: 'Waiting on Acme legal to confirm seat count before scoping.', createdAt: daysAgoIso(now, -2) }],
      },
      {
        id: 'demo-lin-441',
        identifier: 'NW-441',
        title: 'Dashboards: p95 latency widget shows stale data',
        state: { name: 'Todo' },
        team: { name: 'Eng' },
        priorityLabel: 'Normal',
        assignee: { name: 'Jordan Lee' },
        updatedAt: daysAgoIso(now, -6),
        comments: [],
      },
      {
        id: 'demo-lin-402',
        identifier: 'NW-402',
        title: 'SOC2 evidence collection automation',
        state: { name: 'Backlog' },
        team: { name: 'Ops' },
        priorityLabel: 'Low',
        assignee: { name: 'Unassigned' },
        updatedAt: daysAgoIso(now, -14),
        comments: [],
      },
      {
        id: 'demo-lin-398',
        identifier: 'NW-398',
        title: 'Onboarding: skip connect step when Gmail already linked',
        state: { name: 'Todo' },
        team: { name: 'Product' },
        priorityLabel: 'Normal',
        assignee: { name: 'Priya Raman' },
        updatedAt: daysAgoIso(now, -3),
        comments: [{ body: 'Spec agreed. Needs eng owner.', createdAt: daysAgoIso(now, -3) }],
      },
      {
        id: 'demo-lin-387',
        identifier: 'NW-387',
        title: 'Support: shared inbox macros for tier 1',
        state: { name: 'Backlog' },
        team: { name: 'Ops' },
        priorityLabel: 'Low',
        assignee: { name: 'Unassigned' },
        updatedAt: daysAgoIso(now, -11),
        comments: [],
      },
    ],
  }
}

/* ---------------- Slack ---------------- */

export function demoSlackSearch(now: Date) {
  return {
    messages: {
      matches: [
        {
          channel: { name: 'eng-oncall' },
          username: 'priya',
          permalink: 'https://northwind-labs.slack.com/archives/C01ENG/p100481',
          text: 'staging is throwing 500s on the webhook path again, same as NW-481. I have the fixture fix in review.',
          ts: hoursAgoIso(now, -1.5),
        },
        {
          channel: { name: 'product' },
          username: 'jordan',
          permalink: 'https://northwind-labs.slack.com/archives/C02PROD/p100472',
          text: 'we shipped the billing export to four customers today. feedback so far is good.',
          ts: hoursAgoIso(now, -5),
        },
        {
          channel: { name: 'helpdesk' },
          username: 'acme-ops',
          permalink: 'https://northwind-labs.slack.com/archives/C03HELP/p100458',
          text: 'following up on the SSO ticket from Tuesday, any update?',
          ts: hoursAgoIso(now, -26),
        },
        {
          channel: { name: 'general' },
          username: 'maya',
          permalink: 'https://northwind-labs.slack.com/archives/C01GEN/p100441',
          text: 'deploy freeze from Friday 5pm through the weekend. Land anything critical before then.',
          ts: hoursAgoIso(now, -30),
        },
      ],
    },
  }
}

export function demoSlackChannels() {
  return {
    channels: [
      { name: 'eng-oncall', purpose: 'Incidents and paging', num_members: 9 },
      { name: 'product', purpose: 'Shipping notes and specs', num_members: 9 },
      { name: 'helpdesk', purpose: 'Customer escalations', num_members: 6 },
      { name: 'general', purpose: 'Company wide', num_members: 9 },
    ],
  }
}

export function demoSlackThread(now: Date) {
  return {
    messages: [
      { username: 'acme-ops', text: 'following up on the SSO ticket from Tuesday, any update?', ts: hoursAgoIso(now, -26) },
      { username: 'priya', text: 'scoping is waiting on your seat count from legal. NW-455 has the context.', ts: hoursAgoIso(now, -24) },
      { username: 'acme-ops', text: 'legal says 40 seats. can you confirm the quote this week?', ts: hoursAgoIso(now, -4) },
    ],
  }
}

/* ---------------- GitHub ---------------- */

export function demoGithubPulls(now: Date) {
  return [
    {
      number: 342,
      title: 'fix(webhooks): cap retry backoff at 3 attempts',
      state: 'open',
      draft: false,
      html_url: 'https://github.com/northwind-labs/api/pull/342',
      user: { login: 'jordanlee' },
      status: '2 approvals, CI green',
      updated_at: hoursAgoIso(now, -3),
      head: { ref: 'fix/retry-cap' },
    },
    {
      number: 341,
      title: 'feat(billing): export invoices as CSV',
      state: 'open',
      draft: true,
      html_url: 'https://github.com/northwind-labs/api/pull/341',
      user: { login: 'jordanlee' },
      status: 'draft, needs reviewer',
      updated_at: hoursAgoIso(now, -20),
      head: { ref: 'feat/billing-export' },
    },
    {
      number: 339,
      title: 'chore: bump spectrum sdk',
      state: 'open',
      draft: false,
      html_url: 'https://github.com/northwind-labs/api/pull/339',
      user: { login: 'priyaraman' },
      status: 'CI failing on flake',
      updated_at: daysAgoIso(now, -2),
      head: { ref: 'chore/sdk-bump' },
    },
  ]
}

export function demoGithubIssues(now: Date) {
  return [
    {
      number: 88,
      title: 'Rate limit headers missing on the metrics endpoint',
      state: 'open',
      html_url: 'https://github.com/northwind-labs/api/issues/88',
      status: 'assigned, triaged',
      updated_at: daysAgoIso(now, -1),
    },
    {
      number: 91,
      title: 'Docs: webhook quickstart references the old SDK',
      state: 'open',
      html_url: 'https://github.com/northwind-labs/api/issues/91',
      status: 'assigned',
      updated_at: daysAgoIso(now, -4),
    },
  ]
}

/* ---------------- Notion / Drive / Figma ---------------- */

export function demoNotion(now: Date) {
  return {
    results: [
      {
        title: 'Onboarding revamp one pager',
        url: 'https://notion.so/nw/onboarding-revamp',
        last_edited_at: daysAgoIso(now, -2),
        summary: 'Goal: cut time to first value under ten minutes. Connect-first flow, pre-filled team invite.',
      },
      {
        title: 'Q3 eng priorities',
        url: 'https://notion.so/nw/q3-eng',
        last_edited_at: daysAgoIso(now, -5),
        summary: 'Webhook reliability is P0. SOC2 evidence automation is P2.',
      },
      {
        title: 'Series A narrative v3',
        url: 'https://notion.so/nw/series-a-narrative',
        last_edited_at: daysAgoIso(now, -1),
        summary: 'Net revenue retention 128%. Wedge: webhooks for dev tools, expand into full observability.',
      },
      {
        title: 'Hiring: senior AE scorecard',
        url: 'https://notion.so/nw/senior-ae-scorecard',
        last_edited_at: daysAgoIso(now, -8),
        summary: 'Evidence of a owned quota, a repeatable discovery call, and references from two managers.',
      },
    ],
  }
}

export function demoDrive() {
  return {
    files: [
      { title: 'Northwind pitch deck v6.pdf', url: 'https://drive.google.com/file/d/nw-deck-v6' },
      { title: 'Acme pilot order form.pdf', url: 'https://drive.google.com/file/d/nw-acme-order' },
      { title: 'SOC2 vendor questionnaire responses.xlsx', url: 'https://drive.google.com/file/d/nw-soc2-vendor' },
    ],
  }
}

export function demoFigma() {
  return {
    user: { handle: 'maya@northwind-labs.com', email: 'maya@northwind-labs.com' },
    resources: [{ title: 'Onboarding modal frame 4', url: 'https://figma.com/file/nw-onboarding' }],
  }
}

/* ---------------- Stripe / Plaid / QuickBooks ---------------- */

export function demoStripeBalance() {
  return {
    object: 'balance',
    available: [{ amount: 412000, currency: 'usd' }],
    pending: [{ amount: 88400, currency: 'usd' }],
    formatted_amount: '$4,120.00 available · $884.00 pending',
    status: 'live',
  }
}

export function demoStripeCharges(now: Date) {
  return {
    data: [
      { id: 'demo-ch-1', title: 'Acme Corp platform pilot', amount: 48000, currency: 'usd', status: 'succeeded', created: unixSeconds(now, -72) },
      { id: 'demo-ch-2', title: 'Vertex Data pilot month 2', amount: 12000, currency: 'usd', status: 'succeeded', created: unixSeconds(now, -96) },
      { id: 'demo-ch-3', title: 'Growth plan (annual)', amount: 19000, currency: 'usd', status: 'succeeded', created: unixSeconds(now, -120) },
      { id: 'demo-ch-4', title: 'Growth plan monthly', amount: 1900, currency: 'usd', status: 'succeeded', created: unixSeconds(now, -140) },
      { id: 'demo-ch-5', title: 'Team plan monthly', amount: 9900, currency: 'usd', status: 'succeeded', created: unixSeconds(now, -150) },
      { id: 'demo-ch-6', title: 'Starter plan monthly', amount: 2900, currency: 'usd', status: 'succeeded', created: unixSeconds(now, -160) },
    ],
  }
}

export function demoStripeInvoices(now: Date) {
  return {
    data: [
      { id: 'demo-inv-1', title: 'Acme Corp — pilot invoice', amount: 48000, currency: 'usd', status: 'paid', created: unixSeconds(now, -72) },
      { id: 'demo-inv-2', title: 'Vertex Data — pilot invoice', amount: 12000, currency: 'usd', status: 'open', created: unixSeconds(now, -30) },
    ],
  }
}

export function demoPlaid() {
  return {
    accounts: [
      { name: 'Northwind Operating', amount: 412000, formatted_amount: '$412,000.00', status: 'depository' },
      { name: 'Northwind Payroll', amount: 68000, formatted_amount: '$68,000.00', status: 'depository' },
    ],
  }
}

export function demoQuickbooks() {
  return {
    report: {
      title: 'Profit and loss, last 90 days',
      lines: [
        { name: 'Revenue', amount: 86400, status: 'total' },
        { name: 'Payroll', amount: 71000, status: 'expense' },
        { name: 'Cloud and tooling', amount: 9200, status: 'expense' },
      ],
    },
  }
}

/* ---------------- HubSpot / Salesforce / Intercom ---------------- */

export function demoHubspotDeals(now: Date) {
  return {
    results: [
      { id: 'demo-hs-1', properties: { dealname: 'Acme Corp — platform', dealstage: 'contractsent', amount: 48000, closedate: daysAgoIso(now, 5), hubspot_owner_id: 'Sashank' } },
      { id: 'demo-hs-2', properties: { dealname: 'Vertex Data — pilot', dealstage: 'presentationscheduled', amount: 12000, closedate: daysAgoIso(now, 12), hubspot_owner_id: 'Sashank' } },
      { id: 'demo-hs-3', properties: { dealname: 'Brightline — rollout', dealstage: 'qualificationscheduled', amount: 9000, closedate: daysAgoIso(now, 30), hubspot_owner_id: 'Sashank' } },
      { id: 'demo-hs-4', properties: { dealname: 'Harbor Ventures — intro', dealstage: 'appointmentscheduled', amount: 0, closedate: daysAgoIso(now, 21), hubspot_owner_id: 'Sashank' } },
      { id: 'demo-hs-5', properties: { dealname: 'Fieldstone — stale eval', dealstage: 'qualificationscheduled', amount: 6000, closedate: daysAgoIso(now, 45), hubspot_owner_id: 'Sashank' } },
    ],
  }
}

export function demoSalesforce(now: Date) {
  return {
    results: [
      { title: 'Acme Corp — platform', status: 'Contract sent', amount: 48000, url: 'https://salesforce.com/nw/acme' },
      { title: 'Vertex Data — pilot', status: 'Demo scheduled', amount: 12000, url: 'https://salesforce.com/nw/vertex' },
    ],
  }
}

export function demoIntercom(now: Date) {
  return {
    conversations: [
      { title: 'SSO seat count', text: 'Acme legal confirmed 40 seats. Quote needed this week.', status: 'open', created_at: hoursAgoIso(now, -4) },
      { title: 'Webhook drops on staging', text: 'Two customers hit the retry drop. Fix in review as PR 342.', status: 'open', created_at: hoursAgoIso(now, -20) },
      { title: 'Billing export format', text: 'Four customers asked for CSV export. Shipped today.', status: 'closed', created_at: daysAgoIso(now, -1) },
    ],
  }
}

/* ---------------- Jira / Sentry / Zoom (light) ---------------- */

export function demoJira(now: Date) {
  return {
    issues: [
      { title: 'OPS-22 Mirror the Linear board to Jira for the enterprise pilot', status: 'To Do', updated: daysAgoIso(now, -3) },
    ],
  }
}

export function demoSentry(now: Date) {
  return {
    issues: [
      { title: 'WebhookRetryError: exceeded 3 attempts on staging', status: 'unresolved', text: '12 events in the last 24h, all on the retry path', updated: hoursAgoIso(now, -2) },
    ],
  }
}

export function demoZoom() {
  return {
    meetings: [
      { title: 'Eng standup', status: 'scheduled', join_url: 'https://zoom.us/j/nw-standup' },
      { title: 'Acme pricing call', status: 'scheduled', join_url: 'https://zoom.us/j/nw-acme' },
    ],
  }
}

/* ---------------- Dispatcher ---------------- */

/**
 * The Composio-shaped answer for one tool slug in the demo workspace.
 * `null` means "not mocked" — callers treat it like a failed read, which
 * keeps demo writes honest (they never pretend to succeed).
 */
export function demoToolkitData(
  toolkit: DemoToolkit,
  tool: string,
  args: Record<string, unknown>,
  now: Date,
): unknown | null {
  switch (toolkit) {
    case 'gmail':
      if (tool === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID' || tool === 'GMAIL_GET_MESSAGE') {
        const want = String(args.message_id || args.messageId || '')
        const hit = demoGmail(now).messages.find((m) => m.messageId === want)
        return hit || null
      }
      return demoGmail(now)
    case 'googlecalendar':
      return filterCalendar(demoCalendar(now), args)
    case 'googledrive':
      return demoDrive()
    case 'slack':
      if (tool === 'SLACK_LIST_CHANNELS') return demoSlackChannels()
      if (tool === 'SLACK_FETCH_CONVERSATION_HISTORY') return demoSlackThread(now)
      return filterSlackSearch(demoSlackSearch(now), args)
    case 'linear':
      return demoLinearIssues(now)
    case 'notion':
      return demoNotion(now)
    case 'github':
      if (/ISSUE/i.test(tool)) return demoGithubIssues(now)
      return demoGithubPulls(now)
    case 'figma':
      return demoFigma()
    case 'stripe':
      if (/BALANCE/i.test(tool)) return demoStripeBalance()
      if (/INVOICE/i.test(tool)) return demoStripeInvoices(now)
      return demoStripeCharges(now)
    case 'plaid':
      return demoPlaid()
    case 'quickbooks':
      return demoQuickbooks()
    case 'hubspot':
      return demoHubspotDeals(now)
    case 'salesforce':
      return demoSalesforce(now)
    case 'intercom':
      return demoIntercom(now)
    case 'jira':
      return demoJira(now)
    case 'sentry':
      return demoSentry(now)
    case 'zoom':
      return demoZoom()
    default:
      return null
  }
}

/** Honor the window the caller asked for so "tomorrow" stays empty when asked. */
function filterCalendar(
  data: { items: Array<{ summary: string; start: { dateTime: string }; end?: { dateTime: string }; description?: string; hangoutLink?: string }> },
  args: Record<string, unknown>,
) {
  const min = Date.parse(String(args.timeMin || args.time_min || ''))
  const max = Date.parse(String(args.timeMax || args.time_max || ''))
  if (!Number.isFinite(min) && !Number.isFinite(max)) return data
  const items = data.items.filter((e) => {
    const t = Date.parse(e.start.dateTime)
    if (Number.isFinite(min) && t < min) return false
    if (Number.isFinite(max) && t > max) return false
    return true
  })
  return { items }
}

function filterSlackSearch(
  data: { messages: { matches: Array<{ channel: { name: string }; username: string; permalink: string; text: string; ts: string }> } },
  args: Record<string, unknown>,
) {
  const query = String(args.query || '').trim().toLowerCase()
  if (!query) return data
  const words = query.split(/\s+/).filter((w) => w.length > 3)
  if (!words.length) return data
  const hits = data.messages.matches.filter((m) => words.some((w) => m.text.toLowerCase().includes(w)))
  return { messages: { matches: hits.length ? hits : data.messages.matches.slice(0, 2) } }
}
