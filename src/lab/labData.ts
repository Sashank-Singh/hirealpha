/* Mock data for the Alpha email prototypes.
 *
 * Shaped after the real mail pipeline so the prototypes argue about product
 * behaviour rather than about fake fields: `kind` matches `MailKind` in
 * deploy/gmailHelpers.ts, `reasons` matches `MailScoreReason`, and Waiting
 * threads map to the `OpenLoop` rows the loops engine already tracks. Nothing
 * here touches the network — every prototype is a pure render of this module.
 */

export type MailKind = 'reply' | 'thanks' | 'assessment' | 'money' | 'delivery' | 'other'
export type MailReason = 'waiting_on_you' | 'deadline' | 'vip_sender' | 'money' | 'delivery'

export type MailState = 'now' | 'waiting' | 'later'

export type Sender = {
  name: string
  email: string
  org?: string
  /** Someone the user reliably answers — drives the "you usually reply" chip. */
  vip?: boolean
  /** Stable hue for the generated avatar; no image assets in the prototypes. */
  hue: number
}

export type SuggestedAction = {
  label: string
  /** What Alpha does when the user taps it, in Alpha's own words. */
  detail: string
  kind: 'draft' | 'nudge' | 'rsvp' | 'sign' | 'file' | 'snooze'
}

export type Draft = {
  subject: string
  body: string
}

export type AltDraft = {
  label: string
  body: string
}

export type MailThread = {
  id: string
  from: Sender
  subject: string
  /** Gmail-style envelope preview, exactly as the sender wrote it. */
  snippet: string
  /** Alpha's one-line read of the thread. This is the thing users actually read. */
  summary: string
  /** The concrete request, stripped of greeting and throat-clearing. */
  ask?: string
  /** Plain-language consequence. Never a restatement of the summary. */
  why: string
  reasons: MailReason[]
  kind: MailKind
  state: MailState
  /** Relative arrival, already human ("07:12", "Yesterday"). */
  arrived: string
  /** Full body paragraphs, for the reading pane in V1. */
  body: string[]
  suggested?: SuggestedAction
  draft?: Draft
  alts?: AltDraft[]
  deadline?: { label: string; when: string; hoursLeft: number }
  /** Set on Waiting threads: the user acted, the other side owes them. */
  waiting?: {
    what: string
    since: string
    days: number
    /** The line the user set. Past it, Alpha offers to chase. */
    expectBy: string
    overdue: boolean
  }
  nudge?: Draft
  /** Set on Later threads: what Alpha did instead of asking. */
  filed?: { bucket: string; note: string }
  threadCount?: number
}

/* Today is fixed so every prototype and every screenshot agrees. */
export const TODAY = 'Tuesday, 23 September'
export const BRIEF_TIME = '7:30am'
export const USER = { first: 'Maya', full: 'Maya Ortiz', email: 'maya@mayaortiz.com' }

export const THREADS: MailThread[] = [
  /* ── Now: a person is waiting on a decision only the user can make ────── */
  {
    id: 't1',
    from: { name: 'Priya Raman', email: 'priya@northwindlabs.com', org: 'Northwind Labs', vip: true, hue: 268 },
    subject: 'Next step: 45-min technical interview',
    snippet: 'Hi Maya — great news, the team wants to move you forward. Can you send 2-3 slots that work this week? We can hold one until Thursday EOD.',
    summary: 'Priya offered you three interview slots and is holding one until Thursday 5pm.',
    ask: "Pick a time for your 45-minute interview. She is holding one slot until Thursday 5pm."
    why: 'The slot she is holding expires Thursday. Reply with a time and the interview is booked — nothing else is blocking it.',
    reasons: ['deadline', 'vip_sender'],
    kind: 'assessment',
    state: 'now',
    arrived: '07:12',
    threadCount: 4,
    deadline: { label: 'Slot hold expires', when: 'Thu 5:00pm', hoursLeft: 33 },
    body: [
      'Hi Maya —',
      'Great news: the team wants to move you forward to the technical round. This one is 45 minutes with two engineers, no take-home.',
      'I can hold one of these for you until Thursday EOD:',
      '• Thursday 10:00am\n• Thursday 3:30pm\n• Friday 2:00pm',
      'Send me whichever works and I will get the invite out today.',
      '— Priya',
    ],
    suggested: { label: 'Reply with Thursday', detail: 'Sends Priya your pick and books the invite. You review before it goes.', kind: 'draft' },
    draft: {
      subject: 'Re: Next step: 45-min technical interview',
      body: 'Hi Priya,\n\nThanks for the quick turnaround — Thursday 10:00am works well on my end.\n\nHappy to take Friday 2:00pm if that is easier for the engineers.\n\nBest,\nMaya',
    },
    alts: [
      { label: 'Shorter', body: 'Hi Priya — Thursday 10:00am works. Send the invite and I am there.\n\nThanks,\nMaya' },
      { label: 'Warmer', body: 'Hi Priya,\n\nThis is great to hear, thank you. Thursday 10:00am is perfect for me — and I have room Friday 2:00pm too if the engineers prefer.\n\nLooking forward to it,\nMaya' },
      { label: 'Offer all three', body: 'Hi Priya — any of the three work, so take the one that suits the engineers. Thursday 10:00am would be my first pick.\n\nBest,\nMaya' },
    ],
  },
  {
    id: 't2',
    from: { name: 'Marcus Bell', email: 'marcus@lumenhealth.io', org: 'Lumen Health', hue: 172 },
    subject: 'Moving Thursday’s sync?',
    snippet: 'Something came up with the board meeting. Could we push our 2pm to Friday morning instead? Need to lock the room today.',
    summary: 'Marcus needs to move Thursday’s 2pm sync and proposed Friday morning.',
    ask: "Confirm Friday 9:30am so he can book the room today."
    why: 'You are the last yes. He cannot book the room until you confirm, and two other people are waiting on that decision.',
    reasons: ['waiting_on_you'],
    kind: 'reply',
    state: 'now',
    arrived: '06:48',
    threadCount: 2,
    body: [
      'Hey Maya,',
      'The board moved their session into Thursday afternoon, so our 2pm is now a conflict on my side.',
      'Could we do Friday 9:30am instead? Same room, same hour. I need to lock it today or we lose the space.',
      'Sorry for the shuffle — this one is not on you.',
      'Marcus',
    ],
    suggested: { label: 'Say yes to Friday', detail: 'Confirms Friday 9:30 and adds it to your calendar.', kind: 'draft' },
    draft: {
      subject: 'Re: Moving Thursday’s sync?',
      body: 'Hey Marcus,\n\nFriday 9:30 works. Lock the room.\n\nIf the board runs long again, ping me and I will flex.\n\n— Maya',
    },
    alts: [
      { label: 'Ask for 11am', body: 'Hey Marcus,\n\nFriday works, but 9:30 collides with my standup. Can we do 11:00 instead? Same room is fine.\n\n— Maya' },
    ],
  },
  {
    id: 't3',
    from: { name: 'Greg Alvarez', email: 'greg@oakstreetproperties.com', org: 'Oak Street Properties', hue: 32 },
    subject: 'Lease renewal — signature needed by Sept 30',
    snippet: 'Attached is the renewal at the same terms. Rent adjusts to 2,480 on Nov 1. The e-sign link expires Sept 30.',
    summary: 'Renewal terms are unchanged except rent, which goes to $2,480 on 1 November. The e-sign link expires 30 September.',
    ask: "Sign the renewal before the link expires on the 30th."
    why: 'Your autopay is tied to the current lease. If the signature lands after the 30th, the portal re-opens the whole application.',
    reasons: ['deadline', 'money'],
    kind: 'money',
    state: 'now',
    arrived: 'Yesterday',
    deadline: { label: 'E-sign expires', when: 'Sep 30', hoursLeft: 168 },
    body: [
      'Hi Maya,',
      'Your renewal is ready. Same terms as the current lease, with the annual adjustment: $2,480/month effective November 1.',
      'The e-sign link below is valid through September 30. After that date the file closes and we would need a fresh application, which I would rather spare you.',
      'Nothing else changes — parking and the storage unit carry over.',
      'Greg',
    ],
    suggested: { label: 'Sign at the kitchen table', detail: 'Opens the e-sign in a new tab. Alpha keeps the PDF and the deadline.', kind: 'sign' },
    draft: {
      subject: 'Re: Lease renewal — signature needed by Sept 30',
      body: 'Hi Greg,\n\nThanks — one question before I sign: is the parking spot still included at no change?\n\nIf yes, I will have it signed before the weekend.\n\nMaya',
    },
    alts: [
      { label: 'Ask for 3 months', body: 'Hi Greg,\n\nBefore I sign — is a 3-month extension possible at this rate instead of the full year?\n\nMaya' },
    ],
  },
  {
    id: 't4',
    from: { name: 'Sarah Chen', email: 'sarah.chen@outlook.com', org: 'Kellner Fellowship', hue: 316 },
    subject: 'Can you read my draft before Friday?',
    snippet: 'I know this is a big ask with everything you have going on. Even twenty minutes of notes would change the shape of it.',
    summary: 'Sarah sent her fellowship essay and asked for notes before Friday.',
    ask: "Notes on her fellowship draft by Friday."
    why: 'She asked you directly and named a date. A short "yes, by Thursday" is enough — the draft itself can wait for a proper read.',
    reasons: ['waiting_on_you', 'deadline'],
    kind: 'reply',
    state: 'now',
    arrived: 'Yesterday',
    threadCount: 3,
    deadline: { label: 'Friday', when: 'Fri', hoursLeft: 72 },
    body: [
      'Hi Maya,',
      'The fellowship deadline is Sunday, which means I am in the ugly part of the draft where I cannot tell if the opening works anymore.',
      'I know this is a big ask with everything you have going on. Even twenty minutes of notes would change the shape of it — I am not asking for a line edit.',
      'If Friday is too tight, tell me and I will find someone else rather than put this on you.',
      'Thank you either way,\nSarah',
    ],
    suggested: { label: 'Commit to Thursday notes', detail: 'Promises notes by Thursday and offers to talk Friday if she wants.', kind: 'draft' },
    draft: {
      subject: 'Re: Can you read my draft before Friday?',
      body: 'Sarah,\n\nYes — send it. I will get you notes by Thursday evening, focused on the opening and the arc, not line edits.\n\nIf it is easier, we can talk it through Friday morning for half an hour.\n\nMaya',
    },
    alts: [
      { label: 'Softer no', body: 'Sarah — I cannot give this the read it deserves this week. If a quick 20-minute call Thursday helps, I am yours. Otherwise send it to Dana, she is sharper on this than me.\n\nMaya' },
    ],
  },
  {
    id: 't5',
    from: { name: 'Jules Moreau', email: 'jules@hey.com', hue: 8 },
    subject: 'Saturday — we’re 8, need a yes',
    snippet: 'Booking the table tomorrow. Say the word and you are in. Bring whoever, but I need a number.',
    summary: 'Jules is booking Saturday’s birthday dinner tomorrow and needs a headcount.',
    ask: "A headcount for Saturday's dinner before noon tomorrow."
    why: 'You are one of two people who have not answered, and the table gets booked at noon tomorrow.',
    reasons: ['waiting_on_you'],
    kind: 'reply',
    state: 'now',
    arrived: 'Yesterday',
    body: [
      'Maya!',
      'Saturday, 7pm, that place with the terrible lighting and the good pasta. We are 8 so far.',
      'Booking the table tomorrow. Say the word and you are in. Bring whoever, but I need a number.',
      'Jules',
    ],
    suggested: { label: 'In, plus one', detail: 'Replies yes for two and adds Saturday 7pm to your calendar.', kind: 'rsvp' },
    draft: {
      subject: 'Re: Saturday — we’re 8, need a yes',
      body: 'In. Two of us.\n\nTell me what to bring — I am not showing up empty-handed to a birthday.\n\nMaya',
    },
    alts: [{ label: 'In, solo', body: 'In, just me. Saturday 7pm, yes.\n\nMaya' }],
  },

  /* ── Waiting: the user acted, someone else owes the next move ─────────── */
  {
    id: 't6',
    from: { name: 'Prof. Elena Alvarez', email: 'e.alvarez@westfield.edu', org: 'Westfield University', vip: true, hue: 210 },
    subject: 'Recommendation letter',
    snippet: 'You: Sent the updated CV and the portal link. Nothing back yet.',
    summary: 'You asked for the recommendation letter four days ago. She has not replied.',
    ask: "The recommendation letter, before the portal closes on the 28th."
    why: 'The portal closes the 28th. A short nudge today keeps the letter on track without seeming pushy.',
    reasons: ['waiting_on_you'],
    kind: 'reply',
    state: 'waiting',
    arrived: '4 days ago',
    threadCount: 2,
    body: [
      'Dear Professor Alvarez,',
      'I hope the semester is treating you well. I am applying to the Kellner Fellowship and would be grateful for a letter.',
      'The portal closes September 28 and I have attached an updated CV plus the prompt they gave me.',
      'Thank you for considering it,\nMaya',
    ],
    waiting: { what: 'Your recommendation letter', since: 'You asked 4 days ago', days: 4, expectBy: 'Friday', overdue: false },
    nudge: {
      subject: 'Re: Recommendation letter',
      body: 'Dear Professor Alvarez,\n\nA quick note in case my last email got buried — the portal closes September 28.\n\nI have everything ready on my side, so if you are able to submit, it is a single link and about ten minutes.\n\nWith thanks,\nMaya',
    },
  },
  {
    id: 't7',
    from: { name: 'Brightline Studio', email: 'ap@brightlinestudio.co', org: 'Brightline Studio', hue: 12 },
    subject: 'Invoice #204 — 9 days past due',
    snippet: 'You: Sent invoice #204 for 3,400 on Sept 9. No payment, no reply.',
    summary: 'Invoice #204 for $3,400 is nine days past due. No reply to your last two notes.',
    ask: "$3,400 for invoice #204, nine days past the agreed terms."
    why: 'This is the second time they have run late. The pattern is worth a firmer note, and you set your own line at seven days.',
    reasons: ['money', 'deadline'],
    kind: 'money',
    state: 'waiting',
    arrived: '9 days ago',
    threadCount: 3,
    waiting: { what: '$3,400 — invoice #204', since: 'Sent 9 days ago', days: 9, expectBy: 'Their terms: net 7', overdue: true },
    body: [
      'Hi Dana,',
      'Attaching invoice #204 for the September engagement — $3,400, net 7 as agreed.',
      'Let me know if anything is needed on the paperwork side.\n\nMaya',
    ],
    nudge: {
      subject: 'Re: Invoice #204 — past due',
      body: 'Hi Dana,\n\nInvoice #204 is now nine days past the net-7 terms, and this is the second cycle it has slipped.\n\nCould you confirm a payment date today? If it helps, I can re-send it to whoever handles AP — just point me at them.\n\nHappy to keep the work moving, but I do need this one cleared.\n\nMaya',
    },
  },
  {
    id: 't8',
    from: { name: 'Dana Osei', email: 'dana@meridian.vc', org: 'Meridian', hue: 190 },
    subject: 'Intro: you ↔ their platform lead',
    snippet: 'You: Said yes to the intro 6 days ago. No introduction has been made yet.',
    summary: 'You said yes to Dana’s intro six days ago and nothing has been sent yet.',
    ask: "The introduction you already said yes to."
    why: 'Intros go cold fast. A one-line nudge here is normal, not rude — she likely queued it and forgot.',
    reasons: ['waiting_on_you'],
    kind: 'other',
    state: 'waiting',
    arrived: '6 days ago',
    body: ['Dana — yes please, always happy to meet platform people. Copy me whenever suits.', 'Thanks,\nMaya'],
    waiting: { what: 'The intro to their platform lead', since: 'You agreed 6 days ago', days: 6, expectBy: 'You usually see intros within 3 days', overdue: true },
    nudge: {
      subject: 'Re: Intro: you ↔ their platform lead',
      body: 'Dana — no rush at all, just floating this back up in case it slipped through.\n\nStill very happy to meet them whenever it is convenient.\n\nMaya',
    },
  },
  {
    id: 't9',
    from: { name: 'Figma Billing', email: 'support@figma.com', org: 'Figma', hue: 340 },
    subject: 'Ticket #88214 — seat count question',
    snippet: 'You: Asked why the invoice shows 6 seats instead of 4. Support has not answered.',
    summary: 'Support has not answered your seat-count question in three days.',
    ask: "An answer on the six-seat invoice before it runs again."
    why: 'They promised a response within 48 hours and missed it. Worth one follow-up before the next invoice runs.',
    reasons: ['waiting_on_you'],
    kind: 'money',
    state: 'waiting',
    arrived: '3 days ago',
    body: ['Hi — my last invoice shows 6 seats but the team is 4. Can someone confirm whether this is a billing error?', 'Thanks,\nMaya'],
    waiting: { what: 'Answer on the 6-seat invoice', since: 'Asked 3 days ago', days: 3, expectBy: 'Their SLA: 48 hours', overdue: true },
    nudge: {
      subject: 'Re: Ticket #88214 — seat count question',
      body: 'Following up on ticket #88214 — the 48-hour window has passed and the next invoice runs Friday.\n\nCan someone confirm the seat count before then?\n\nThanks,\nMaya',
    },
  },

  /* ── Later: Alpha already decided these never needed a human ──────────── */
  {
    id: 't10',
    from: { name: 'Figma', email: 'receipts@figma.com', org: 'Figma', hue: 340 },
    subject: 'Your receipt from Figma',
    snippet: 'Receipt for your Figma Professional subscription, $18.00, paid Sept 22.',
    summary: 'Receipt for your Figma subscription, $18.00.',
    why: 'Matched to a subscription you already approved. Nothing to decide.',
    reasons: ['money'],
    kind: 'money',
    state: 'later',
    arrived: 'Yesterday',
    body: ['Receipt for your Figma Professional subscription.', 'Amount paid: $18.00', 'Payment method: card ending 4471'],
    filed: { bucket: 'Receipts', note: 'Filed under Receipts · Figma · matched to your subscription' },
  },
  {
    id: 't11',
    from: { name: 'Stripe', email: 'no-reply@stripe.com', org: 'Stripe', hue: 258 },
    subject: 'Your payout of $2,140.00 is on the way',
    snippet: 'Your payout of 2,140.00 USD is expected to arrive in your account on Sept 24.',
    summary: 'Payout of $2,140 arrives tomorrow.',
    why: 'Expected money. Alpha logged it next to the Brightline invoice you are already chasing.',
    reasons: ['money'],
    kind: 'money',
    state: 'later',
    arrived: 'Yesterday',
    body: ['Your payout of $2,140.00 USD is expected to arrive in your bank account on September 24.'],
    filed: { bucket: 'Money', note: 'Logged under Money · payout · expected Sept 24' },
  },
  {
    id: 't12',
    from: { name: 'The Diff', email: 'hello@thediff.co', org: 'The Diff', hue: 96 },
    subject: 'The quiet unbundling of the vertical SaaS stack',
    snippet: 'This week: why the mid-market is buying point solutions again, and what it does to pricing.',
    summary: 'Newsletter. No action.',
    why: 'You subscribed for the Sunday read and you never reply to it.',
    reasons: [],
    kind: 'other',
    state: 'later',
    arrived: 'Yesterday',
    body: ['This week: why the mid-market is buying point solutions again, and what it does to pricing.'],
    filed: { bucket: 'Reading', note: 'Filed under Reading · kept for Sunday' },
  },
  {
    id: 't13',
    from: { name: 'LinkedIn', email: 'jobalerts-noreply@linkedin.com', org: 'LinkedIn', hue: 214 },
    subject: '14 new jobs match “Founding Engineer”',
    snippet: 'Northwind Labs and 13 others are hiring for Founding Engineer in your area.',
    summary: 'Job alert. 14 roles.',
    why: 'Bulk alert, no sender waiting. Alpha keeps them out of your day unless you ask.',
    reasons: [],
    kind: 'other',
    state: 'later',
    arrived: '06:00',
    body: ['14 new jobs match “Founding Engineer”.'],
    filed: { bucket: 'Noise', note: 'Filed under Noise · alerts · never interrupts you' },
  },
  {
    id: 't14',
    from: { name: 'Amazon', email: 'ship-confirm@amazon.com', org: 'Amazon', hue: 40 },
    subject: 'Arriving today: 1 package',
    snippet: 'Your order of magnesium and vitamin D arrives today between 4pm and 6pm.',
    summary: 'Your vitamins arrive today between 4 and 6pm.',
    why: 'You are home. Alpha kept the tracking link just in case.',
    reasons: ['delivery'],
    kind: 'delivery',
    state: 'later',
    arrived: '05:40',
    body: ['Your order arrives today between 4:00pm and 6:00pm.'],
    filed: { bucket: 'Deliveries', note: 'Filed under Deliveries · tracking link kept until it lands' },
  },
  {
    id: 't15',
    from: { name: 'Notion', email: 'team@makenotion.com', org: 'Notion', hue: 0 },
    subject: 'Aisha invited you to “Q4 Planning”',
    snippet: 'Aisha added you to the Q4 Planning workspace with edit access.',
    summary: 'Workspace invite from Aisha, edit access.',
    why: 'Invites do not need a reply unless they name one. Alpha added it and moved on.',
    reasons: [],
    kind: 'other',
    state: 'later',
    arrived: 'Yesterday',
    body: ['Aisha added you to the Q4 Planning workspace with edit access.'],
    filed: { bucket: 'Invites', note: 'Filed under Invites · added to your workspace list' },
  },
  {
    id: 't16',
    from: { name: 'Uber', email: 'receipts@uber.com', org: 'Uber', hue: 200 },
    subject: 'Your Tuesday morning trip',
    snippet: 'Total: 23.40. Thanks for riding with Uber.',
    summary: 'Trip receipt, $23.40.',
    why: 'Receipt against a card you already track. Nothing to decide.',
    reasons: ['money'],
    kind: 'money',
    state: 'later',
    arrived: '08:12',
    body: ['Total: $23.40', 'Thanks for riding with Uber.'],
    filed: { bucket: 'Receipts', note: 'Filed under Receipts · Uber · $23.40' },
  },
  {
    id: 't17',
    from: { name: 'Chase', email: 'statements@chase.com', org: 'Chase', hue: 220 },
    subject: 'Your September statement is ready',
    snippet: 'Your statement for account ending 8821 is available online.',
    summary: 'September statement is ready.',
    why: 'Statements are retrievable any time. Alpha noted the balance change and left it.',
    reasons: ['money'],
    kind: 'money',
    state: 'later',
    arrived: 'Monday',
    body: ['Your statement for account ending 8821 is available online.'],
    filed: { bucket: 'Money', note: 'Filed under Money · statement · balance noted' },
  },
  {
    id: 't18',
    from: { name: 'Linear', email: 'notifications@linear.app', org: 'Linear', hue: 250 },
    subject: 'EN-441 was marked Done',
    snippet: 'Priya moved “Interview loop: scheduling” to Done.',
    summary: 'Status change on a ticket you follow.',
    why: 'State change from a tool, no person waiting. Alpha watched it so you do not have to.',
    reasons: [],
    kind: 'other',
    state: 'later',
    arrived: 'Monday',
    body: ['Priya moved “Interview loop: scheduling” to Done.'],
    filed: { bucket: 'Tools', note: 'Filed under Tools · status updates you follow' },
  },
]

export const CHIP_LABELS: Record<MailReason, string> = {
  waiting_on_you: 'waiting on you',
  deadline: 'deadline',
  vip_sender: 'you usually reply',
  money: 'money',
  delivery: 'delivery',
}

/* Filing buckets, in the order Alpha would present them. */
export const FILED_ORDER = ['Receipts', 'Money', 'Deliveries', 'Invites', 'Reading', 'Tools', 'Noise']

export function filedBuckets(threads: MailThread[] = THREADS) {
  const later = threads.filter((t) => t.state === 'later')
  return FILED_ORDER.map((bucket) => ({
    bucket,
    items: later.filter((t) => t.filed?.bucket === bucket),
  })).filter((g) => g.items.length > 0)
}

export const NOW = THREADS.filter((t) => t.state === 'now')
export const WAITING = THREADS.filter((t) => t.state === 'waiting')
export const LATER = THREADS.filter((t) => t.state === 'later')

/** The headline numbers the brief and the queue both quote. */
export const TALLY = {
  scanned: 31,
  needsYou: NOW.length,
  drafted: 3,
  filed: LATER.length,
  autoSent: 0,
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (/^[A-Z]{2,}$/.test(parts[0]!)) return parts[0]!.slice(0, 2)
  const first = parts[0]![0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : ''
  return `${first}${last}`.toUpperCase()
}

/** Warm, low-saturation avatar tint from the sender hue — calm, not a rainbow. */
export function avatarTint(hue: number): { bg: string; fg: string } {
  return {
    bg: `hsl(${hue} 22% 22%)`,
    fg: `hsl(${hue} 46% 84%)`,
  }
}
