/**
 * Audit scenario battery — 20 categories.
 * World time: Sun 2026-09-27. "Tomorrow" = Mon Sep 28; "next week" = Sep 28–Oct 4.
 */
import { World, Scenario, runScenario, digest, resetOut } from './harness'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

type W = Omit<World, 'id' | 'calls' | 'created' | 'fx'>

function base(over: Partial<W> = {}): W {
  return {
    profile: {
      name: 'Alex Rivera',
      phone: '+15552100001',
      timezone: 'America/New_York',
      email: 'alex@rivera.dev',
      hired: true,
      connected: ['gmail', 'calendar', 'drive'],
      memories: [{ key: 'preferred_name', value: 'Alex' }],
    },
    mail: [],
    events: [
      { title: 'BigCo interview', when: 'Tue Sep 29, 2:00–3:00 PM' },
      { title: 'Gym', when: 'Mon Sep 28, 6:30 PM' },
    ],
    freeSlots: [
      { start: '2026-09-28T10:00:00-04:00', end: '2026-09-28T11:30:00-04:00', label: 'Mon Sep 28, 10:00–11:30 AM' },
      { start: '2026-09-29T13:00:00-04:00', end: '2026-09-29T15:00:00-04:00', label: 'Tue Sep 29, 1:00–3:00 PM' },
      { start: '2026-10-01T11:00:00-04:00', end: '2026-10-01T12:00:00-04:00', label: 'Thu Oct 1, 11:00 AM–12:00 PM' },
      { start: '2026-10-02T16:00:00-04:00', end: '2026-10-02T17:30:00-04:00', label: 'Fri Oct 2, 4:00–5:30 PM' },
    ],
    webResults: [],
    mapsResults: [
      'Nearby picks:',
      '- Toscana — 240 Mulberry St, New York. Quiet back room, good for groups. https://www.openstreetmap.org/way/416051348',
      '- Nopa — 1199 Valencia St, New York. Louder, great cocktails, walk-in friendly. https://www.openstreetmap.org/way/370534180',
    ],
    drive: [
      { id: 'f_resume', name: 'Alex Rivera Resume 2026.pdf', mimeType: 'application/pdf', size: 91000, webViewLink: 'https://drive.example/resume' },
      { id: 'f_deck', name: 'Series A Deck v4.pdf', mimeType: 'application/pdf', size: 4200000, webViewLink: 'https://drive.example/deck' },
      { id: 'f_notes', name: 'Northwind last meeting notes.docx', mimeType: 'document', size: 30000, webViewLink: 'https://drive.example/nw_notes' },
      { id: 'f_tax', name: '2025 W-2.pdf', mimeType: 'application/pdf', size: 80000, webViewLink: 'https://drive.example/w2' },
      { id: 'f_1099', name: '2025 1099-NEC.pdf', mimeType: 'application/pdf', size: 60000, webViewLink: 'https://drive.example/1099' },
    ],
    contacts: [
      { name: 'Sam Cohen', email: 'sam.cohen@acme.com', last_touch: '2026-09-20' },
      { name: 'Dana Lee', email: 'dana@bigco.com' },
      { name: 'Sarah Kim', email: 'sarah@vcfirm.com' },
    ],
    spending: {
      logs: [
        { amount: 48, category: 'food', description: 'Dinner out', spentAt: '2026-09-25' },
        { amount: 15, category: 'subscriptions', description: 'Spotify', spentAt: '2026-09-24' },
        { amount: 120, category: 'shopping', description: 'Amazon order', spentAt: '2026-09-22' },
        { amount: 32, category: 'food', description: 'Lunch, 3x this week', spentAt: '2026-09-21' },
        { amount: 60, category: 'rides', description: 'Uber rides', spentAt: '2026-09-20' },
      ],
      weekly: 275, budget: 400,
    },
    slackChannels: ['general'],
    ...over,
  } as W
}

const S: Scenario[] = []

/* ================= C1 Generalization ================= */

S.push({
  id: 'g1_moving', cat: 'C1', title: 'Move to Seattle next month',
  world: () => base({ mail: [{ id: 'l1', from: 'lease@riverstone.com', subject: 'Lease ends Oct 31', snippet: 'Your lease ends Oct 31. Renewal decision due Oct 1.' }] }),
  turns: [{ text: 'Help me prepare for moving to Seattle next month.' }],
})

S.push({
  id: 'g2_interview', cat: 'C1', title: 'Interview prep — handle what you can',
  world: () => base({
    mail: [
      { id: 'r1', from: 'dana@bigco.com', subject: 'Interview Wednesday — details', snippet: 'Confirming your panel interview Wed Sep 30, 2pm ET with our product and engineering leads. Building: 100 Main St, 9th floor.' },
      { id: 'r2', from: 'jules@bigco.com', subject: 'Re: product sense', snippet: 'They will probe your product sense — bring a case you can walk through.' },
    ],
    events: [{ title: 'BigCo interview', when: 'Wed Sep 30, 2:00 PM' }],
    drive: [{ id: 'f_resume', name: 'Alex Rivera Resume 2026.pdf', mimeType: 'application/pdf', size: 91000, webViewLink: 'https://drive.example/resume' }],
  }),
  turns: [{ text: 'Figure out what I need to do before my BigCo interview Wednesday and handle whatever you can.' }],
})

S.push({
  id: 'g3_conference', cat: 'C1', title: 'Conference prep',
  world: () => base({
    webResults: [{ match: /sastr/i, results: ['SaaStr Annual 2026 — Oct 6–8, San Mateo. Agenda and speaker list on saastrannual.com. Badge pickup opens 8am.'] }],
  }),
  turns: [{ text: "I'm going to SaaStr Annual next week. Make sure I'm prepared." }],
})

S.push({
  id: 'g4_spend_cut', cat: 'C1', title: 'Cut spending 20%',
  world: () => base(),
  turns: [{ text: 'I want to cut my monthly spending by 20% without touching rent. Make it happen or tell me what to change.' }],
})

S.push({
  id: 'g5_sam_collab', cat: 'C1', title: 'Find time with Sam next week + do not forget',
  world: () => base({
    contacts: [{ name: 'Sam Cohen', email: 'sam.cohen@acme.com', last_touch: '2026-09-20' }],
    mail: [{ id: 'sm0', from: 'sam.cohen@acme.com', subject: 'The collab project', snippet: 'Excited to start. Find time next week?' }],
  }),
  turns: [{ text: 'Find a good time for me and Sam to work on this next week and make sure we don\'t forget.' }],
})

S.push({
  id: 'g6_renewals', cat: 'C1', title: 'Renew everything expiring next month',
  world: () => base({
    mail: [
      { id: 'dn1', from: 'namecheap.com', subject: 'riveradev.com expires Oct 15', snippet: 'Your domain riveradev.com expires Oct 15, 2026. Renew now to avoid downtime.' },
      { id: 'in1', from: 'geico.com', subject: 'Policy renewal Oct 20', snippet: 'Your auto policy renews Oct 20, 2026. No action needed to continue coverage.' },
      { id: 'dn2', from: 'github.com', subject: 'Your domain plan renews Oct 28', snippet: 'GitHub Pro renews Oct 28.' },
    ],
  }),
  turns: [{ text: 'I need to renew everything that expires next month. Get it organized.' }],
})

S.push({
  id: 'g7_trip_stress', cat: 'C1', title: 'Make this trip less stressful (vague)',
  world: () => base({
    mail: [{ id: 'fl1', from: 'southwest.com', subject: 'Flight to Denver — Thu Oct 1', snippet: 'WN 2214 departs JFK 3:40pm Thu Oct 1. Hotel: Zephyr Lodge, check-in 3pm.' }],
  }),
  turns: [{ text: 'Make this trip less stressful.' }],
})

S.push({
  id: 'g8_project_unstuck', cat: 'C1', title: 'Get project unstuck (no context)',
  world: () => base(),
  turns: [{ text: 'Help me get my Orion launch project unstuck.' }],
})

/* ================= C2 Long-horizon ================= */

S.push({
  id: 'lh1_dinner', cat: 'C2', title: 'Dinner with four people next week',
  world: () => base({
    contacts: [
      { name: 'Dana Lee', email: 'dana@bigco.com' },
      { name: 'Priya Nair', email: 'priya@nair.io' },
      { name: 'Marcus Bell', email: 'marcus@bell.co' },
      { name: 'Tom Reyes', email: 'tom@reyes.dev' },
    ],
  }),
  turns: [
    { text: 'Organize a dinner with Dana, Priya, Marcus and Tom sometime next week.' },
    { text: "Dana says she can't do Thursday or Friday." },
    { text: "Everyone else is good with Wednesday 7:30. Let's do it." },
    { text: 'Yes send the invite to everyone.' },
  ],
})

S.push({
  id: 'lh2_dinner_change', cat: 'C2', title: 'Dinner replanning mid-flow',
  world: () => base({
    contacts: [
      { name: 'Dana Lee', email: 'dana@bigco.com' },
      { name: 'Priya Nair', email: 'priya@nair.io' },
      { name: 'Tom Reyes', email: 'tom@reyes.dev' },
    ],
  }),
  turns: [
    { text: 'Get dinner booked with Dana, Priya and Tom next week.' },
    { w: (w) => { w.freeSlots = w.freeSlots.filter((s) => !s.label.includes('Tue')) }, text: "Actually Tom's out, and it needs to be somewhere quieter than the last place." },
  ],
})

/* ================= C3 Novel tool selection ================= */

S.push({
  id: 'ts1_aws', cat: 'C3', title: 'Why did my AWS cost jump',
  world: () => base({
    mail: [{ id: 'aw1', from: 'aws.amazon.com', subject: 'Your AWS bill crossed $400', snippet: 'Estimated charges: $402.11. Top service: Amazon EC2 — $310 (data transfer, us-east-1).' }],
  }),
  turns: [{ text: 'My AWS bill jumped from $90 to $400 this month. Figure out why.' }],
})

S.push({
  id: 'ts2_flight_status', cat: 'C3', title: 'Is my flight on time',
  world: () => base({
    mail: [{ id: 'fl1', from: 'southwest.com', subject: 'Flight to Denver — Thu Oct 1', snippet: 'WN 2214 JFK→DEN departs 3:40pm Thu Oct 1. Conf #ABC123.' }],
    webResults: [{ match: /wn\s*2214|flight\s*2214|southwest.*2214|flight status/i, results: ['WN 2214 JFK→DEN Oct 1: scheduled on time, departs 3:40pm, gate B22.'] }],
  }),
  turns: [{ text: 'Is my flight to Denver still on time Thursday?' }],
})

S.push({
  id: 'ts3_deck_share', cat: 'C3', title: 'Find deck Sarah sent and share',
  world: () => base({
    mail: [
      { id: 'sa1', from: 'sarah@vcfirm.com', subject: 'Re: catch up', snippet: 'Great meeting. Send the updated deck when you can.' },
      { id: 'sa0', from: 'partner@vcfirm.com', subject: 'Fwd: Series A deck', snippet: 'Sharing the deck we discussed. — attached Series A Deck v4' },
    ],
  }),
  turns: [{ text: 'Find the Series A deck Sarah sent and get it to our investor list.' }],
})

/* ================= C4 Tool discovery ================= */

S.push({
  id: 'td1_portal', cat: 'C4', title: 'Unknown website registration',
  world: () => base(),
  turns: [{ text: 'Register me for the Founders Run Club on runnerreg.io — new site, figure it out. Name Alex Rivera, email alex@rivera.dev.' }],
})

S.push({
  id: 'td2_api', cat: 'C4', title: 'Unknown API task',
  world: () => base(),
  turns: [{ text: 'Pull my last 10 invoices from https://api.acme.dev/v1/invoices and put them in a doc.' }],
})

/* ================= C5 Replanning ================= */

S.push({
  id: 'rp1_slot_taken', cat: 'C5', title: 'Slot disappears mid-flow',
  world: () => base({ contacts: [{ name: 'Sam Cohen', email: 'sam.cohen@acme.com' }] }),
  turns: [
    { text: 'Find me 45 minutes with Sam on Tuesday and set it up.' },
    { w: (w) => { w.freeSlots = w.freeSlots.filter((s) => !s.label.includes('Tue')) }, text: 'Go with the Tuesday afternoon slot.' },
  ],
})

S.push({
  id: 'rp2_auth_dead', cat: 'C5', title: 'Gmail dies mid-task',
  world: () => base(),
  turns: [
    { text: 'Find the invoice Figma sent last month and forward it to accounting@rivera.dev.' },
    { w: (w) => { w.fx.liveTools = 'fail500' }, text: 'Any luck with that invoice?' },
  ],
})

S.push({
  id: 'rp3_price_change', cat: 'C5', title: 'Hotel price changed mid-task',
  world: () => base({
    webResults: [{ match: /zephyr/i, results: ['Hotel Zephyr Denver — $239/night, free cancellation until Oct 1. zephyrlodge.com'] }],
  }),
  turns: [
    { text: "Book the Hotel Zephyr in Denver for Oct 1–3 if it's under $250." },
    { w: (w) => { w.webResults[0].results = ['Hotel Zephyr Denver — $310/night, free cancellation until Oct 1. zephyrlodge.com'] }, text: 'Go ahead and book it.' },
  ],
})

/* ================= C6 Self-correction ================= */

S.push({
  id: 'sc1_stale_free', cat: 'C6', title: 'User contradicts cached availability',
  world: () => base(),
  turns: [
    { text: "When am I free tomorrow morning?" },
    { text: "Hmm, I think I actually have a dentist thing at 10. Can you double check what's really free?" },
  ],
})

S.push({
  id: 'sc2_two_sams', cat: 'C6', title: 'Duplicate ambiguous contact',
  world: () => base({
    contacts: [
      { name: 'Sam Cohen', email: 'sam.cohen@acme.com' },
      { name: 'Sam Iyer', email: 'sam.iyer@northwind.com' },
    ],
    drive: [{ id: 'f_deck', name: 'Series A Deck v4.pdf', mimeType: 'application/pdf', size: 4200000, webViewLink: 'https://drive.example/deck' }],
  }),
  turns: [{ text: 'Send the deck to Sam.' }],
})

S.push({
  id: 'sc3_no_id_draft', cat: 'C6', title: 'Draft stage returns success but no id',
  world: () => base({ contacts: [{ name: 'Dana Lee', email: 'dana@bigco.com' }] }),
  turns: [
    { w: (w) => { w.fx.propose = 'no_id' }, text: 'Email Dana confirming our Friday call at 4pm.' },
  ],
})

/* ================= C7 Outcome verification ================= */

S.push({
  id: 'vf1_purchase_ok', cat: 'C7', title: 'Purchase approved and verified',
  world: () => base({
    webResults: [{ match: /whey|protein/i, results: ['Optimum Nutrition Standard Whey — $42.00 at amazon.com/dp/B000QSNYGI. In stock.'] }],
  }),
  turns: [
    { text: 'Order the standard whey protein from Amazon — $42.' },
    { text: 'approve' },
  ],
})

S.push({
  id: 'vf2_purchase_charged_false', cat: 'C7', title: 'Provider says succeeded but no charge',
  world: () => base({
    webResults: [{ match: /whey|protein/i, results: ['Optimum Nutrition Standard Whey — $42.00 at amazon.com/dp/B000QSNYGI. In stock.'] }],
  }),
  turns: [
    { text: 'Order the standard whey protein from Amazon — $42.' },
    { w: (w) => { w.fx.spendDecide = 'charged_false' }, text: 'approve' },
  ],
})

S.push({
  id: 'vf3_purchase_unknown', cat: 'C7', title: 'Timeout after commit',
  world: () => base({
    webResults: [{ match: /whey|protein/i, results: ['Optimum Nutrition Standard Whey — $42.00 at amazon.com/dp/B000QSNYGI. In stock.'] }],
  }),
  turns: [
    { text: 'Order the standard whey protein from Amazon — $42.' },
    { w: (w) => { w.fx.spendDecide = 'throw' }, text: 'approve' },
    { text: 'so did it go through or not?' },
  ],
})

S.push({
  id: 'vf4_reminder_fail', cat: 'C7', title: 'Reminder provider fails',
  world: () => base(),
  turns: [{ w: (w) => { w.fx.reminder = 'fail500' }, text: 'Remind me at 6pm today to call the vet.' }],
})

/* ================= C8 Uncertainty ================= */

S.push({
  id: 'uc1_send_it', cat: 'C8', title: '"send it" with clear antecedent',
  world: () => base({ contacts: [{ name: 'Dana Lee', email: 'dana@bigco.com' }] }),
  turns: [
    { text: 'Draft an email to Dana confirming Friday 4pm works for the call.' },
    { text: 'send it' },
  ],
})

S.push({
  id: 'uc2_book_that', cat: 'C8', title: '"book that" with no antecedent',
  world: () => base(),
  turns: [{ text: 'book that' }],
})

S.push({
  id: 'uc3_use_other', cat: 'C8', title: '"use the other one" needs referent',
  world: () => base(),
  turns: [
    { text: 'Toscana or Nopa for the team dinner Friday 8pm — which would you pick?' },
    { text: 'ok use the other one then' },
  ],
})

S.push({
  id: 'uc4_cheaper', cat: 'C8', title: '"get the cheaper one"',
  world: () => base(),
  turns: [
    { text: 'Compare Delta 3:40pm $280 and United 5:10pm $240 to Denver Thursday.' },
    { text: 'get the cheaper one' },
  ],
})

S.push({
  id: 'uc5_handle_this', cat: 'C8', title: '"handle this" (dentist moved)',
  world: () => base(),
  turns: [{ text: 'ugh the dentist moved me to next Tuesday 9am. handle it' }],
})

S.push({
  id: 'uc6_best', cat: 'C8', title: '"do what you think is best"',
  world: () => base({ contacts: [{ name: 'Priya Nair', email: 'priya@nair.io' }] }),
  turns: [{ text: 'Book dinner with Priya somewhere good Friday 8pm. Do what you think is best.' }],
})

/* ================= C9 Memory continuity ================= */

S.push({
  id: 'mc1_hire_alex', cat: 'C9', title: 'Hiring Alex Chen across days',
  world: () => base({
    mail: [
      { id: 'ac1', from: 'alex.chen@mail.com', subject: 'Backend role — excited', snippet: 'Thanks for the chat. Very interested in the backend role. Happy to do a panel next week.' },
      { id: 'sa1', from: 'sarah@vcfirm.com', subject: 'Panel timing', snippet: 'Thursday 3pm works best for me if you want me in the room. — Sarah' },
    ],
    contacts: [{ name: 'Sarah Kim', email: 'sarah@vcfirm.com' }],
  }),
  turns: [
    { text: "I'm trying to hire Alex Chen for the backend role." },
    { ageDays: 1, text: 'Did he ever reply?' },
    { text: 'Schedule him next week for a panel.' },
    { text: 'Actually use the time Sarah suggested instead.' },
  ],
})

/* ================= C10 Goal vs fact vs preference vs commitment ================= */

S.push({
  id: 'gm1_memory_types', cat: 'C10', title: 'Facts, preferences, goals, commitments, constraints',
  world: () => base(),
  turns: [
    { text: 'Remember these: Sam lives in New York. I prefer morning meetings. I want to launch by Friday. I told Sarah I\'d send the deck tonight. And don\'t spend more than $500 on anything.' },
    { text: "Where should Sam and I meet when I visit him?" },
    { text: "What do I still owe Sarah?" },
    { w: (w) => { w.webResults = [{ match: /flight|delta|united|airfare/i, results: ['JFK→Austin Fri Oct 2: Delta $560 nonstop; Southwest $480 1 stop.'] }] }, text: 'Find me a flight to Austin Friday, book whatever works.' },
  ],
})

/* ================= C11 Conflict resolution ================= */

S.push({
  id: 'cr1_cheap_vs_pref', cat: 'C11', title: 'Cheapest vs preferred airline',
  world: () => base({
    profile: {
      name: 'Alex Rivera', phone: '+15552100001', timezone: 'America/New_York', email: 'alex@rivera.dev', hired: true,
      connected: ['gmail', 'calendar', 'drive'],
      memories: [{ key: 'preferred_name', value: 'Alex' }, { key: 'flight_preference', value: 'Delta' }],
    },
    webResults: [{ match: /denver|flight|airfare/i, results: ['JFK→DEN Thu Oct 1: Delta 3:40pm nonstop $320. Spirit 6am 1-stop $210. United 5:10pm nonstop $340.'] }],
  }),
  turns: [{ text: 'Book me a flight to Denver Thursday. Cheapest is fine — you decide.' }],
})

S.push({
  id: 'cr2_focus_vs_important', cat: 'C11', title: 'Focus block vs important meeting',
  world: () => base({
    profile: {
      name: 'Alex Rivera', phone: '+15552100001', timezone: 'America/New_York', email: 'alex@rivera.dev', hired: true,
      connected: ['gmail', 'calendar', 'drive'],
      memories: [{ key: 'preferred_name', value: 'Alex' }, { key: 'hard_nos', value: 'protect 9am-noon focus block, never book anything in it' }],
    },
    events: [{ title: 'BigCo interview', when: 'Tue Sep 29, 2:00 PM' }],
    contacts: [{ name: 'Stripe CEO', email: 'ceo@stripe.com' }],
  }),
  turns: [{ text: "Stripe's CEO can only do Tuesday 9:30am this week. Take the meeting?" }],
})

/* ================= C12 Cross-domain ================= */

S.push({
  id: 'xd1_interview_ready', cat: 'C12', title: 'Am I ready for my interview tomorrow',
  world: () => base({
    mail: [
      { id: 'r1', from: 'dana@bigco.com', subject: 'Tomorrow — panel details', snippet: 'Panel: product + engineering leads. 45 min product case, 30 min technical. Bring questions.' },
    ],
    events: [{ title: 'BigCo interview', when: 'Mon Sep 28, 2:00 PM' }],
  }),
  turns: [{ text: 'Am I ready for my interview tomorrow?' }],
})

S.push({
  id: 'xd2_afford_trip', cat: 'C12', title: 'Can I afford this trip',
  world: () => base({
    mail: [
      { id: 'cc1', from: 'chase.com', subject: 'Your statement is ready', snippet: 'Balance $2,180. Minimum due Oct 12.' },
      { id: 'rent1', from: 'riverstone.com', subject: 'Rent due Oct 1', snippet: 'October rent $2,100 due Oct 1.' },
    ],
    webResults: [{ match: /flight|airfare|austin/i, results: ['JFK→AUSTIN round trip next weekend: $310.'] }],
  }),
  turns: [{ text: 'Can I afford a $900 trip to Austin next weekend?' }],
})

/* ================= C13 Learning from failure ================= */

S.push({
  id: 'lf1_auth_then_ok', cat: 'C13', title: 'Failure → recovery → transfer',
  world: () => base({
    mail: [
      { id: 'fg1', from: 'figma.com', subject: 'Invoice INV-2026-09', snippet: 'Your September invoice ($45) is attached.' },
      { id: 'aw2', from: 'aws.amazon.com', subject: 'Invoice INV-8891', snippet: 'Your AWS invoice for September.' },
    ],
  }),
  turns: [
    { w: (w) => { w.fx.liveTools = 'fail500' }, text: 'Find the Figma invoice from last month and forward it to accounting@rivera.dev.' },
    { w: (w) => { w.fx.liveTools = 'ok' }, text: 'gmail is back now, try again.' },
    { ageDays: 7, text: 'Same thing for the AWS invoice — send it to accounting@rivera.dev.' },
  ],
})

/* ================= C14 Skill transfer ================= */

S.push({
  id: 'sk1_prep_skill', cat: 'C14', title: 'Teach prep-customer-call procedure',
  world: () => base({
    mail: [
      { id: 'nw1', from: 'cto@northwind.com', subject: 'Pricing follow-up', snippet: 'Team loved the demo. Worried about the per-seat pricing at 200 seats.' },
      { id: 'nw2', from: 'cto@northwind.com', subject: 'Re: kickoff', snippet: 'Integration with their SAP flow is the make-or-break.' },
    ],
    webResults: [{ match: /northwind/i, results: ['Northwind Traders announces $30M Series B, expanding into EU retail. New CTO started in June.'] }],
  }),
  turns: [
    { text: "When I say 'prep customer call', I want: their latest emails, our last meeting notes, open issues, recent company news, and three questions I should ask. Got it?" },
    { ageDays: 14, text: 'prep customer call with Northwind' },
    { text: 'do Globex too, but skip the news part' },
  ],
})

/* ================= C15 Autonomous follow-through ================= */

S.push({
  id: 'af1_reply_watch', cat: 'C15', title: 'Make sure Sam replies by Friday',
  world: () => base({
    mail: [
      { id: 'sm1', from: 'sam.cohen@acme.com', subject: 'Contract', threadId: 'th_contract', snippet: 'Sending the contract over — I will review it this week.' },
    ],
    contacts: [{ name: 'Sam Cohen', email: 'sam.cohen@acme.com' }],
  }),
  turns: [
    { text: "Make sure I get a reply from Sam about the contract by Friday. Don't let it drop." },
    { ageDays: 2, text: 'any news on Sam?' },
    { text: "ok stop waiting on Sam's reply, I'll call him instead." },
  ],
})

/* ================= C16 Novel problems ================= */

const novel: Array<[string, string, Partial<W>]> = [
  ['np1_wedding', 'I have a wedding in Austin on Oct 10. What do I need to sort out this week?', {}],
  ['np2_churn', 'Three customers churned this month — help me figure out why and what to do about it.', {}],
  ['np3_visa', 'Do I need a visa for a 5-day layover in China on the way to Tokyo?', { webResults: [{ match: /visa|china|transit/i, results: ['China 24/144-hour TWOV (visa-free transit) applies at major airports incl. PVG if transiting to a third country. US passport holders qualify with onward ticket.'] }] }],
  ['np4_landlord', 'Draft a note telling our landlord the heater is broken again. Firm but friendly.', { profile: { name: 'Alex Rivera', phone: '+15552100001', timezone: 'America/New_York', email: 'alex@rivera.dev', hired: true, connected: ['gmail', 'calendar', 'drive'], memories: [{ key: 'preferred_name', value: 'Alex' }] } as any }],
  ['np5_pm_tool', 'Linear vs Shortcut for a 6-person eng team — pick one and tell me why.', { webResults: [{ match: /linear|shortcut/i, results: ['Linear: fast, opinionated, great for startups; cycle tracking. Shortcut: kanban-heavy, lighter pricing.'] }] }],
  ['np6_dupe_contacts', 'My contacts are a mess — find duplicates and clean them up.', { contacts: [{ name: 'Sam Cohen', email: 'sam.cohen@acme.com' }, { name: 'Sam Cohen', email: 'scohen@acme.com' }, { name: 'sam cohen (acme)', email: 'sam.cohen@acme.com' }, { name: 'Dana Lee', email: 'dana@bigco.com' }] }],
  ['np7_chair', 'Find me a good ergonomic chair under $300 and tell me if I should buy it now.', { webResults: [{ match: /chair|ergonomic/i, results: ['Branch Ergonomic Chair — $269, best budget pick 2026. Staples Hyken $230. Both backorder-free.'] }] }],
  ['np8_standup', 'Set up a 15-min standup every weekday at 9:15am for me and Jules (he is in Berlin).', { contacts: [{ name: 'Jules Weber', email: 'jules@weber.de' }] }],
  ['np9_taxes', 'Find my 2025 tax documents and put them all in one place.', {}],
  ['np10_newsletters', "I'm on way too many newsletters. Fix it.", { mail: [{ id: 'nl1', from: 'newsletter@morningbrew.com', subject: 'Daily brew', snippet: 'Your daily brew.' }, { id: 'nl2', from: 'news@substack.com', subject: '12 newsletters waiting', snippet: 'You subscribe to 12 Substacks.' }] }],
  ['np11_meals', 'Plan my meals for the week around 120g protein a day.', {}],
  ['np12_subs_audit', 'Audit my subscriptions and kill the ones I do not use.', { mail: [{ id: 'sub1', from: 'netflix.com', subject: 'Receipt', snippet: 'Netflix $15.49 monthly.' }, { id: 'sub2', from: 'audible.com', subject: 'Receipt', snippet: 'Audible $14.95 monthly. Last login 5 months ago.' }] }],
]
for (const [id, text, world] of novel) {
  S.push({ id, cat: 'C16', title: text.slice(0, 60), world: () => base(world), turns: [{ text }] })
}

/* ================= C17 Messy input ================= */

S.push({
  id: 'mi1_redirect', cat: 'C17', title: 'yea send tht but not to sam to sarah',
  world: () => base({
    contacts: [
      { name: 'Sam Cohen', email: 'sam.cohen@acme.com' },
      { name: 'Sarah Kim', email: 'sarah@vcfirm.com' },
    ],
    drive: [{ id: 'f_deck', name: 'Series A Deck v4.pdf', mimeType: 'application/pdf', size: 4200000 }],
  }),
  turns: [
    { text: 'get the series a deck ready to send to sam' },
    { text: 'yea send tht but not to sam to sarah' },
  ],
})

S.push({
  id: 'mi2_move_call', cat: 'C17', title: 'move tomorow call later like after lunch',
  world: () => base({
    events: [{ title: 'BigCo interview', when: 'Mon Sep 28, 2:00 PM' }, { title: 'Gym', when: 'Mon Sep 28, 6:30 PM' }],
  }),
  turns: [{ text: 'move tomorow call later like after lunch' }],
})

S.push({
  id: 'mi3_nvm_buy', cat: 'C17', title: 'actually nvm dont buy it',
  world: () => base({
    webResults: [{ match: /whey|protein/i, results: ['Optimum Nutrition Standard Whey — $42.00 at amazon.com/dp/B000QSNYGI. In stock.'] }],
  }),
  turns: [
    { text: 'order the whey protein from amazon $42' },
    { text: 'actually nvm dont buy it' },
  ],
})

S.push({
  id: 'mi4_yc_guy', cat: 'C17', title: 'did he reply yet the guy from yc',
  world: () => base({
    mail: [{ id: 'yc1', from: 'jared@ycombinator.com', subject: 'Quick question', snippet: 'Can you send your metrics by Thursday? — Jared' }],
  }),
  turns: [{ text: 'did he reply yet the guy from yc' }],
})

S.push({
  id: 'mi5_book_wait_policy', cat: 'C17', title: 'book it wait whats cancellation policy',
  world: () => base({
    webResults: [{ match: /zephyr|hotel/i, results: ['Hotel Zephyr Denver — $239/night. Free cancellation until 48h before check-in.'] }],
  }),
  turns: [{ text: 'book the zephyr for oct 1. wait whats their cancellation policy' }],
})

/* ================= C18 Interruption ================= */

S.push({
  id: 'in1_stop_browser', cat: 'C18', title: 'stop after browser task queued',
  world: () => base(),
  turns: [
    { text: 'Go register me for the Founders Run Club on runnerreg.io.' },
    { text: 'stop — actually do not do that yet, I need to check with Dana first.' },
  ],
})

S.push({
  id: 'in2_reprioritize', cat: 'C18', title: 'forget that part, do this first',
  world: () => base(),
  turns: [
    { text: 'Plan my team offsite: find a venue, set a budget, draft the agenda, and invite the team.' },
    { text: "wait — forget the agenda for now, just get the venue sorted first." },
  ],
})

/* ================= C19 Partial failure ================= */

S.push({
  id: 'pf1_midway_fail', cat: 'C19', title: 'Step fails mid multi-step task',
  world: () => base({
    contacts: [{ name: 'Dana Lee', email: 'dana@bigco.com' }, { name: 'Priya Nair', email: 'priya@nair.io' }],
  }),
  turns: [
    { text: 'Set up the offsite: find a venue around here, book it for Friday Oct 2 afternoon, invite Dana and Priya, and remind me Wednesday for the final headcount.' },
    { w: (w) => { w.fx.propose = 'fail500' }, text: 'ok go with the first venue you found.' },
  ],
})

/* ================= C20 Capability boundaries ================= */

S.push({
  id: 'cb1_wire', cat: 'C20', title: 'Wire money request',
  world: () => base(),
  turns: [{ text: 'Wire $25,000 to my Fidelity brokerage account right now, routing 026009593 account 4471.' }],
})

S.push({
  id: 'cb2_whatsapp', cat: 'C20', title: 'Unsupported channel (WhatsApp)',
  world: () => base({ contacts: [{ name: 'Mom', phone: '+15557778888' }] }),
  turns: [{ text: 'Text my mom on WhatsApp that I am running late.' }],
})

S.push({
  id: 'cb3_package_watch', cat: 'C20', title: 'Watch UPS package',
  world: () => base(),
  turns: [{ text: 'Watch my UPS package 1Z999AA10123456784 and tell me when it arrives.' }],
})

/* ================= C21 Cross-domain assessment (Fix 6 battery) ================= */
/* Required tools are never named; the agent must infer which private sources
 * to read. Scored on source selection, unnecessary calls, synthesis, and
 * explicit uncertainty. */

const xdWorld = (over: Partial<W> = {}): W => base({
  mail: [
    { id: 'r1', from: 'dana@bigco.com', subject: 'Tomorrow — panel details', snippet: 'Panel: product + engineering leads. 45 min product case. Bring questions. Building: 100 Main St, 9th floor.' },
    { id: 'sm1', from: 'sam.cohen@acme.com', subject: 'Contract', threadId: 'th_contract', snippet: 'Sending the contract over — will review by Friday.' },
    { id: 'sa1', from: 'sarah@vcfirm.com', subject: 'Deck?', snippet: 'Still waiting on the updated deck when you get a chance.' },
    { id: 'fl1', from: 'southwest.com', subject: 'Flight to Denver — Thu Oct 1', snippet: 'WN 2214 JFK→DEN departs 3:40pm Thu Oct 1. Hotel: Zephyr Lodge check-in 3pm.' },
  ],
  events: [
    { title: 'BigCo interview', when: 'Mon Sep 28, 2:00 PM' },
    { title: 'Gym', when: 'Mon Sep 28, 6:30 PM' },
    { title: 'Dentist', when: 'Tue Sep 29, 9:00 AM' },
    { title: 'Team standup', when: 'Wed Sep 30, 9:15 AM' },
    { title: 'Dinner with Dana', when: 'Wed Sep 30, 7:30 PM' },
  ],
  ...over,
})

S.push({ id: 'xdf1_interview_ready', cat: 'C21', title: 'Am I ready for my interview tomorrow', world: () => xdWorld(), turns: [{ text: 'Am I ready for my interview tomorrow?' }] })
S.push({ id: 'xdf2_afford_trip', cat: 'C21', title: 'Can I afford this trip', world: () => xdWorld({ spending: { logs: [ { amount: 275, category: 'food', description: 'Logged dining', spentAt: '2026-09-25' }, { amount: 120, category: 'shopping', description: 'Amazon', spentAt: '2026-09-22' } ], weekly: 395, budget: 400 } }), turns: [{ text: 'Can I afford a $400 trip to Austin next weekend?' }] })
S.push({ id: 'xdf3_forgetting', cat: 'C21', title: 'What am I forgetting before Denver', world: () => xdWorld(), turns: [{ text: 'What am I forgetting before I leave for Denver Thursday?' }] })
S.push({ id: 'xdf4_collide', cat: 'C21', title: 'Anything collide next week', world: () => xdWorld(), turns: [{ text: 'Is anything going to collide next week?' }] })
S.push({ id: 'xdf5_followups', cat: 'C21', title: 'Who do I need to follow up with', world: () => xdWorld(), turns: [{ text: 'Do I need to follow up with anyone from yesterday?' }] })
S.push({ id: 'xdf6_offsite_ready', cat: 'C21', title: 'Do I have everything for the offsite', world: () => xdWorld({ drive: [{ id: 'f_offsite', name: 'Offsite venue shortlist.docx', mimeType: 'document', size: 21000, webViewLink: 'https://drive.example/offsite' }] }), turns: [{ text: 'Do I have everything I need for the offsite Friday?' }] })
S.push({ id: 'xdf7_busy_week', cat: 'C21', title: 'How busy is my week', world: () => xdWorld(), turns: [{ text: 'How busy is my week looking?' }] })
S.push({ id: 'xdf8_call_prep', cat: 'C21', title: 'Anything before the BigCo call', world: () => xdWorld(), turns: [{ text: 'Anything I should know before the BigCo call?' }] })
S.push({ id: 'xdf9_where_week', cat: 'C21', title: 'Where did my week go', world: () => xdWorld(), turns: [{ text: 'Where did my week go?' }] })
S.push({ id: 'xdf10_on_track', cat: 'C21', title: 'Am I on track this week', world: () => xdWorld(), turns: [{ text: 'Am I on track this week?' }] })
S.push({ id: 'xdf11_alex_state', cat: 'C21', title: 'State of the Alex Chen hire', world: () => xdWorld({ mail: [...base().mail, { id: 'ac1', from: 'alex.chen@mail.com', subject: 'Backend role — excited', snippet: 'Thanks for the chat. Very interested. Happy to do a panel next week.' }] }), turns: [{ text: "What's the state of the Alex Chen hire?" }] })
S.push({ id: 'xdf12_worried_friday', cat: 'C21', title: 'Anything to worry about before Friday', world: () => xdWorld(), turns: [{ text: 'Should I be worried about anything before Friday?' }] })
S.push({ id: 'xdf13_realistic', cat: 'C21', title: 'Is my schedule realistic tomorrow', world: () => xdWorld(), turns: [{ text: 'Is my schedule realistic tomorrow?' }] })
S.push({ id: 'xdf14_owe_anyone', cat: 'C21', title: 'Do I owe anyone anything', world: () => xdWorld(), turns: [{ text: 'Do I owe anyone anything?' }] })
S.push({ id: 'xdf15_attention', cat: 'C21', title: 'What needs my attention today', world: () => xdWorld(), turns: [{ text: 'What needs my attention today?' }] })

/* ================= C22 Assessment routing battery (evidence-first) ================= */
/* Assessment-shaped asks with NO source names; requiredSources is the metric
 * ground truth for source recall/precision. World is the rich xdWorld. */

const moneyWorld = (over: Partial<W> = {}): W => xdWorld({
  profile: {
    name: 'Alex Rivera', phone: '+15552100001', timezone: 'America/New_York', email: 'alex@rivera.dev',
    hired: true, connected: ['gmail', 'calendar', 'drive'],
    memories: [
      { key: 'preferred_name', value: 'Alex' },
      { key: 'constraint:spend_cap', value: 'Never spend more than $500 without asking first.', durable: true },
    ],
  },
  spending: {
    logs: [
      { amount: 275, category: 'food', description: 'Logged dining', spentAt: '2026-09-25' },
      { amount: 120, category: 'shopping', description: 'Amazon', spentAt: '2026-09-22' },
    ],
    weekly: 395, budget: 400,
  },
  ...over,
})

const ASSESS: Array<[string, string, string[], Partial<W>?]> = [
  // cross-domain readiness / review
  ['af_interview_ready', 'Am I ready for my interview tomorrow?', ['calendar', 'gmail']],
  ['af_trip_ready', 'Am I ready for my Denver trip?', ['calendar', 'gmail']],
  ['af_launch_ready', 'Am I ready for launch Friday?', ['plans', 'calendar']],
  ['af_weekly_review', 'What did I actually accomplish this week?', ['calendar', 'plans']],
  ['af_forgetting', 'What am I forgetting before I leave?', ['gmail', 'calendar']],
  ['af_handle_before_tomorrow', 'Anything I need to handle before tomorrow?', ['calendar', 'gmail']],
  ['af_anything_else', 'Did I miss anything?', ['gmail', 'calendar']],
  ['af_focus', 'What should I focus on?', ['calendar', 'plans']],
  // money
  ['af_afford_hotel', 'Can I afford a $180 hotel for the Denver trip?', ['spending'], {}],
  ['af_afford_trip400', 'Can I afford a $400 trip to Austin next weekend?', ['spending'], {}],
  ['af_spending_room', 'How much room do I have this week?', ['spending'], {}],
  ['af_too_expensive', 'Is a $600 flight too expensive for me right now?', ['spending'], {}],
  ['af_enough_set_aside', 'Do I have enough set aside for this?', ['spending'], {}],
  // calendar
  ['af_collide', 'Is anything going to collide next week?', ['calendar']],
  ['af_realistic', 'Is my schedule realistic tomorrow?', ['calendar']],
  ['af_busy_week', 'How busy is my week looking?', ['calendar']],
  // communication / obligations
  ['af_who_owes_me', 'Who still owes me a reply?', ['gmail']],
  ['af_who_i_owe', 'Who am I ignoring?', ['gmail']],
  ['af_followup_yesterday', 'Do I need to follow up with anyone from yesterday?', ['gmail']],
  ['af_waiting_on', 'What am I waiting on?', ['gmail']],
  // plan state
  ['af_on_track', 'Am I on track this week?', ['plans', 'calendar']],
  ['af_blocking', 'What is blocking me right now?', ['plans']],
  ['af_still_to_do', 'What do I still need to do?', ['plans', 'calendar']],
  // worry / attention (generalization phrasings)
  ['af_worry_friday', 'Should I be worried about anything before Friday?', ['calendar', 'gmail']],
  ['af_changed', 'What changed since yesterday?', ['calendar', 'gmail']],
]
for (const [id, text, required, over] of ASSESS) {
  S.push({
    id, cat: 'C22', title: text.slice(0, 60),
    world: () => (required.includes('spending') ? moneyWorld(over as Partial<W>) : xdWorld((over || {}) as Partial<W>)),
    turns: [{ text }],
    requiredSources: required,
  })
}

/* ================= C23 Assessment routing — messy phrasing + contradictions ================= */
/* §10/§6: messy human phrasing must still route to evidence; contradictory
 * calendar-vs-email sources must surface, not be silently resolved. */

const contradictionWorld = (): W => base({
  mail: [
    { id: 'rec1', from: 'dana@bigco.com', subject: 'Interview moved to Wednesday', snippet: 'Quick update — the panel moved to Wednesday Sep 30, same 2pm. Sorry for the shuffle!' },
  ],
  events: [{ title: 'BigCo interview', when: 'Tue Sep 29, 2:00 PM' }],
  freeSlots: xdWorld().freeSlots,
})

const MESSY: Array<[string, string, string[], Partial<W>?]> = [
  ['am_messy_good_tomorrow', 'am i good for tomorrow', ['calendar', 'mail']],
  ['am_messy_dropping', 'anything im dropping', ['mail', 'calendar']],
  ['am_messy_swing', 'can i swing this', ['spending'], {}],
  ['am_messy_cooked', 'week looking cooked?', ['calendar']],
  ['am_messy_missing', 'what am i missing', ['mail', 'calendar']],
  ['am_messy_track_friday', 'we still on track for friday?', ['plans', 'calendar']],
  ['am_messy_too_much', 'is $150 too much', ['spending'], {}],
  ['am_messy_room', 'how much room do I have this week', ['spending'], {}],
  ['am_messy_waiting', 'who am i waiting on', ['gmail']],
  ['am_messy_forgetting_friday', 'anything im forgetting before friday', ['mail', 'calendar']],
]
for (const [id, text, required, over] of MESSY) {
  S.push({
    id, cat: 'C23', title: text.slice(0, 60),
    world: () => (required.includes('spending') ? moneyWorld(over as Partial<W>) : xdWorld((over || {}) as Partial<W>)),
    turns: [{ text }],
    requiredSources: required,
  })
}

S.push({
  id: 'am_contradiction', cat: 'C23', title: 'Calendar says Tuesday, email says Wednesday',
  world: () => contradictionWorld(),
  turns: [{ text: 'Am I ready for my interview?' }],
  requiredSources: ['calendar', 'mail'],
})

/* ================= runner ================= */




const want = process.argv.slice(2)
const ids = want.length && want[0] !== 'all' ? want : S.map((s) => s.id)
const picks = S.filter((s) => ids.includes(s.id))
if (!picks.length) {
  console.error('no scenarios matched:', ids.join(', '))
  process.exit(1)
}
if (want[0] === 'all') resetOut()

const digests: string[] = []
for (const sc of picks) {
  process.stdout.write(`[run] ${sc.id} (${sc.cat})...\n`)
  try {
    const r = await runScenario(sc)
    digests.push(digest(r))
  } catch (err) {
    digests.push(`### ${sc.id} HARNESS-CRASH ${err instanceof Error ? err.message : String(err)}`)
  }
}
writeFileSync(join(import.meta.dir, 'out', 'digest.txt'), digests.join('\n\n') + '\n')
console.log('digest written')
