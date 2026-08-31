import type { AgentId } from '../agents/types'

/**
 * Sample threads for the "what texting a hire looks like" wall.
 *
 * These are illustrative threads in the product's voice — the same scripted
 * texture the landing demo and the bots' own system prompts use. They are NOT
 * real user conversations. As real exchanges come in (with consent), replace
 * entries here or extend the type with image screenshots; the component is
 * data-driven so nothing else needs to change.
 */

export interface HighlightLinkPreview {
  url: string
  title: string
  siteName?: string
  image: string
  desc?: string
}

export interface HighlightBubble {
  from: 'me' | 'them'
  text: string
  /** Small tool chip shown on the bubble (Gmail, Maps, Spending, …). */
  app?: string
  /** Optional image attachment */
  image?: string
  /** Authentic iOS iMessage OpenGraph link preview card */
  linkPreview?: HighlightLinkPreview
  /** A mini-app card rendered in-thread (Approve & send, Investor note, …). */
  card?: { app: string; title: string }
}

export interface HighlightHalfSheet {
  app: string
  title: string
  image: string
  badge?: string
}

export interface HighlightThread {
  persona: AgentId
  title: string
  caption: string
  bubbles: HighlightBubble[]
  halfSheet?: HighlightHalfSheet
}

export const HIGHLIGHTS: HighlightThread[] = [
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Evening wrap, loops closed & personal',
    bubbles: [
      {
        from: 'them',
        app: 'Brief',
        text: "day's wrapped. 6h sleep last night, morning run logged, 3 meetings crushed. 2 loops still open: send tax docs to accountant, reply to mom (she texted at noon):",
        linkPreview: {
          url: 'https://hirealpha.chat/app/mini/friend/pick_night',
          title: "Tonight's Plan: HireAlpha",
          siteName: 'HIREALPHA.CHAT',
          image: '/images/og/pick_night.png',
          desc: 'Compare plans and decide what to do tonight.',
        },
      },
      { from: 'me', text: "reply to mom for me, tell her we're flying in thursday" },
      {
        from: 'them',
        app: 'Draft',
        text: '"hey mom! flight\'s confirmed for thursday at 6pm. can\'t wait to see you and dad, love you!"',
      },
      { from: 'them', text: 'say the word and it goes' },
      { from: 'me', text: 'send it' },
    ],
  },
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Photo meal logging & mini apps',
    bubbles: [
      {
        from: 'me',
        image: '/chipotle-bowl.jpg',
        text: 'half a chipotle bowl with double chicken and guac. what are my macros looking like today?',
      },
      {
        from: 'them',
        app: 'Nutrition',
        text: "Logged to Nutrition: ~620 cal, 48g protein, 24g fat, 42g carbs. You're at 112g/150g protein today:",
      },
      { from: 'me', text: 'nice, log 1 scoop whey too' },
      {
        from: 'them',
        text: 'done. 136g protein locked in (91% of goal). 14g left for dinner:',
      },
    ],
    halfSheet: {
      app: 'Nutrition Tracker',
      title: 'Today · Daily Progress',
      badge: '136g / 150g (91%)',
      image: '/images/nutrition-sheet-preview.jpg',
    },
  },
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Sleep & recovery, adapting your schedule',
    bubbles: [
      {
        from: 'them',
        app: 'Sleep',
        text: "slept 5h 40m, woke up twice. deep sleep was low. moved your 7am heavy lifting to 6pm so you don't burn out:",
        linkPreview: {
          url: 'https://hirealpha.chat/app/mini/friend/sleep_tracker',
          title: 'Sleep Tracker: HireAlpha',
          siteName: 'HIREALPHA.CHAT',
          image: '/images/og/sleep_tracker.png',
          desc: 'Last night: 5h 40m · Recovery 64%',
        },
      },
      { from: 'me', text: 'thank you. block 20 mins after lunch for a quick nap too' },
      {
        from: 'them',
        app: 'Calendar',
        text: 'blocked 1:15 to 1:45 PM. notifications muted, soft alarm set for 1:40.',
      },
    ],
  },
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Habits & streaks, real daily momentum',
    bubbles: [
      {
        from: 'them',
        app: 'Habits',
        text: "day 14 of no screens in bed + 20 min reading locked in. 4-day streak on morning runs. you're 1 day away from your personal best.",
      },
      { from: 'me', text: 'reading done tonight. this book is actually insane' },
      {
        from: 'them',
        app: 'Habits',
        text: 'streak updated: Day 15 🔥 put the phone face down and get some sleep.',
        linkPreview: {
          url: 'https://hirealpha.chat/app/mini/friend/habit_streak',
          title: 'Habit Streak: HireAlpha',
          siteName: 'HIREALPHA.CHAT',
          image: '/images/og/habit_streak.png',
          desc: 'Active streak: Day 15 🔥',
        },
      },
    ],
  },
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Interactive apps & games, built in seconds',
    bubbles: [
      { from: 'me', text: 'can you build me a quick ping pong game to kill 10 mins?' },
      {
        from: 'them',
        app: 'Build',
        text: 'built it. touch controls, keeps score, physics are tight:',
        linkPreview: {
          url: 'https://hirealpha.chat/b/ping-pong',
          title: 'Alpha Apps: HireAlpha',
          siteName: 'HIREALPHA.CHAT',
          image: '/images/og/apps.png',
          desc: 'Tap one to open it.',
        },
      },
      { from: 'them', text: 'hirealpha.chat/b/ping-pong' },
      { from: 'me', text: 'yo this actually runs so smooth' },
      { from: 'them', text: "beat 15 and i'll draft your standup for you" },
    ],
  },
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Live tickets & real-time search, handled',
    bubbles: [
      { from: 'me', text: 'check if there are odyssey tickets in 70mm imax this friday' },
      {
        from: 'them',
        app: 'Search',
        text: 'Metreon has 2 seats left at 7:15 PM row F. AMC Cupertino is sold out.',
        linkPreview: {
          url: 'https://fandango.com/amc-metreon-16',
          title: 'AMC Metreon 16: Fandango Tickets',
          siteName: 'FANDANGO.COM',
          image: '/images/og/default.png',
          desc: 'Friday 7:15 PM · 70mm IMAX Row F (2 left)',
        },
      },
      { from: 'me', text: 'snagged them. block 6:30 to 10:30 on my cal' },
      {
        from: 'them',
        app: 'Calendar',
        text: 'done. blocked with travel buffer. enjoy 70mm',
      },
    ],
  },
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Bank data & subscriptions, caught early',
    bubbles: [
      { from: 'me', text: 'did that gym charge hit my checking yet?' },
      {
        from: 'them',
        app: 'Bank',
        text: 'yep, $180 hit Chase checking yesterday. also caught a $29 duplicate subscription from Figma:',
        linkPreview: {
          url: 'https://hirealpha.chat/app/mini/friend/spending_snapshot',
          title: 'Spending Snapshot: HireAlpha',
          siteName: 'HIREALPHA.CHAT',
          image: '/images/og/spending_snapshot.png',
          desc: 'Live bank balance & transactions',
        },
      },
      { from: 'me', text: 'wait really? draft an email to get a refund' },
      {
        from: 'them',
        app: 'Gmail',
        text: '"Hi Figma support, looks like invoice #8492 was charged twice on Aug 28. Could you refund the extra $29?"',
        card: { app: 'Approve & send', title: 'Refund draft to Figma · waiting on you' },
      },
      { from: 'them', text: 'Should I send it?' },
      { from: 'me', text: 'yes please, send it' },
    ],
  },
  {
    persona: 'coworker',
    title: 'Alpha (Coworker)',
    caption: 'Engineering standups, compiled from git logs',
    bubbles: [
      { from: 'me', text: 'what did i even ship yesterday? standup in 5' },
      {
        from: 'them',
        app: 'GitHub',
        text: "merged PR #142 (auth flow refactor), resolved 3 staging regressions, approved Priya's DB migration",
      },
      {
        from: 'them',
        app: 'Standup',
        text: '"Yesterday: Shipped core auth refactor, closed 3 staging regressions, reviewed DB schema migration. Today: Finalizing Stripe webhook listeners and end-to-end checkout testing. Blockers: None."',
        linkPreview: {
          url: 'https://hirealpha.chat/app/mini/coworker/standup_paste',
          title: 'Standup Paste: HireAlpha',
          siteName: 'HIREALPHA.CHAT',
          image: '/images/og/standup_paste.png',
          desc: 'Compiled from GitHub & Linear',
        },
      },
      { from: 'me', text: 'copied and pasted. you just saved my life' },
    ],
  },
  {
    persona: 'cofounder',
    title: 'Alpha(CoFounder)',
    caption: 'Hard startup truths, logged decisions',
    bubbles: [
      { from: 'me', text: 'marketing agency wants $12k/mo to "grow our socials"' },
      {
        from: 'them',
        text: "that burns 1.4 months of runway for zero high-intent leads. you closed 5 enterprise pilots this week from cold outreach. double down on what’s working.",
      },
      { from: 'me', text: "yeah you're right. kill the proposal" },
      {
        from: 'them',
        app: 'Decisions',
        text: 'logged as Kill. runway preserved at 11 months. staying focused on outbound:',
        linkPreview: {
          url: 'https://hirealpha.chat/app/mini/cofounder/decision_ledger',
          title: 'Decision Ledger: HireAlpha',
          siteName: 'HIREALPHA.CHAT',
          image: '/images/og/decision_ledger.png',
          desc: 'Strategic startup decision log',
        },
      },
      {
        from: 'them',
        text: 'the monthly investor note is drafted too, from the pipeline numbers:',
        card: { app: 'Investor note', title: 'March update · review before it sends' },
      },
    ],
  },
]
