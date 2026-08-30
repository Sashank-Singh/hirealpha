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

export interface HighlightBubble {
  from: 'me' | 'them'
  text: string
  /** Small tool chip shown on the bubble (Gmail, Maps, Spending, …). */
  app?: string
}

export interface HighlightThread {
  persona: AgentId
  title: string
  caption: string
  bubbles: HighlightBubble[]
}

export const HIGHLIGHTS: HighlightThread[] = [
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Daily evening wrap, personal & loop-free',
    bubbles: [
      {
        from: 'them',
        app: 'Brief',
        text: "day's wrapped. 6h sleep last night, morning run logged, 3 meetings crushed. 2 loops still open: send tax docs to accountant, reply to mom (she texted at noon).",
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
    caption: 'Interactive apps & games, built in seconds',
    bubbles: [
      { from: 'me', text: 'can you build me a quick ping pong game to kill 10 mins?' },
      {
        from: 'them',
        app: 'Build',
        text: 'built it. touch controls, keeps score, physics are tight:',
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
        text: 'Metreon has 2 seats left at 7:15 PM row F. AMC Cupertino is sold out. Grab Metreon here: fandango.com/...',
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
        app: 'Plaid',
        text: 'yep, $180 hit Chase checking yesterday. also caught a $29 duplicate subscription from Figma',
      },
      { from: 'me', text: 'wait really? draft an email to get a refund' },
      {
        from: 'them',
        app: 'Gmail',
        text: '"Hi Figma support, looks like invoice #8492 was charged twice on Aug 28. Could you refund the extra $29?"',
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
        text: 'logged as Kill. runway preserved at 11 months. staying focused on outbound.',
      },
    ],
  },
]
