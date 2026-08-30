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
    caption: 'Your day, wrapped every night',
    bubbles: [
      {
        from: 'them',
        app: 'Brief',
        text: 'Here is your day in one look. You slept 6 hours 12 minutes, your legs are done, and dinner with Michael is set for 8:45. One person still owes you a reply: your mom.',
      },
      { from: 'me', text: 'Draft that reply for me, please.' },
      {
        from: 'them',
        text: 'Done. It says: "Hey Mom, alive and well. Are we still on for the Saturday call?" Read it over, and it sends the moment you approve.',
      },
      { from: 'me', text: 'That is perfect. Send it.' },
    ],
  },
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Spending, caught every week',
    bubbles: [
      { from: 'me', text: 'What did I spend this week?' },
      {
        from: 'them',
        app: 'Spending',
        text: 'You spent $462, which is $218 over your weekly budget. The pattern is dinners out — three of them in the last seven nights. That is where the money went.',
      },
      { from: 'me', text: 'Ugh. Help me fix it.' },
      {
        from: 'them',
        text: 'Two home-cooked recipes are queued for Saturday. Keep that up and the $218 you just saved becomes trip money instead.',
      },
    ],
  },
  {
    persona: 'coworker',
    title: 'Alpha (Coworker)',
    caption: 'Meeting prep, before the meeting',
    bubbles: [
      { from: 'me', text: 'Prep me for Priya at 2.' },
      {
        from: 'them',
        text: 'Here is what matters: Priya asked for last week\'s numbers and an update on the invoice dispute. Where things stand — four deals closed this week, three more in the pipeline, and the invoice reply is drafted and waiting for you.',
      },
      {
        from: 'them',
        app: 'Gmail',
        text: 'The reply is sitting in Approve and send. Nothing goes out until you tap approve.',
      },
      { from: 'me', text: 'Send it.' },
      {
        from: 'them',
        text: 'Sent. The full recap will land in your evening brief at 4:30.',
      },
    ],
  },
  {
    persona: 'cofounder',
    title: 'Alpha(CoFounder)',
    caption: 'A decision, captured and logged',
    bubbles: [
      { from: 'me', text: 'Should we hire a VP of sales first, or a senior AE?' },
      {
        from: 'them',
        text: 'A VP is a $300,000 way to avoid doing the calls yourself. What actually moves the company is ten real conversations, with you on them. My recommendation: no VP yet.',
      },
      { from: 'me', text: 'They also want $18,000 for a site redesign.' },
      {
        from: 'them',
        app: 'Decisions',
        text: 'Fourteen people came back this week — that is the company. The redesign can wait. I logged this decision with the reasoning, so we can revisit it in ninety days and see if it held up.',
      },
      { from: 'me', text: 'Good. Logged.' },
    ],
  },
]
