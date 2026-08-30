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
        text: 'Here is your day in one look. You slept about six hours, your workout is done, and dinner with Michael is set for 8:45. One person still owes you a reply: your mom.',
      },
      { from: 'me', text: 'draft it for me' },
      {
        from: 'them',
        text: 'Done. It says: "hey mom! still good for our call saturday?" It is short because that is how you two text. Look it over and it goes out when you tap.',
      },
      { from: 'me', text: 'perfect. send it' },
    ],
  },
  {
    persona: 'friend',
    title: 'Alpha',
    caption: 'Spending, caught every week',
    bubbles: [
      { from: 'me', text: 'how much did i spend this week' },
      {
        from: 'them',
        app: 'Spending',
        text: 'You spent $462, which is $218 over your weekly budget. The pattern is dinners out, three of them in the last seven nights. That is where it all went.',
      },
      { from: 'me', text: 'ugh. help me fix it' },
      {
        from: 'them',
        text: 'Two easy home recipes are queued for Saturday. Keep that up and the $218 you just saved becomes trip money instead.',
      },
    ],
  },
  {
    persona: 'coworker',
    title: 'Alpha (Coworker)',
    caption: 'Meeting prep, before the meeting',
    bubbles: [
      { from: 'me', text: 'prep me for priya at 2' },
      {
        from: 'them',
        text: 'Here is what matters: Priya asked for last week\u2019s numbers and an update on the invoice dispute. Where things stand, four deals closed this week, three more in the pipeline, and the invoice reply is drafted and waiting for you.',
      },
      {
        from: 'them',
        app: 'Gmail',
        text: 'The reply is sitting in Approve and send. Nothing goes out until you tap approve.',
      },
      { from: 'me', text: 'send it' },
      {
        from: 'them',
        text: 'Sent. The full recap lands in your evening brief at 4:30.',
      },
    ],
  },
  {
    persona: 'cofounder',
    title: 'Alpha(CoFounder)',
    caption: 'A decision, captured and logged',
    bubbles: [
      { from: 'me', text: 'vp sales first, or senior ae?' },
      {
        from: 'them',
        text: 'A VP is a $300,000 way to avoid doing the calls yourself. What actually moves the company is ten real conversations, with you on them. So no VP yet.',
      },
      { from: 'me', text: 'they also want $18,000 for a site redesign' },
      {
        from: 'them',
        app: 'Decisions',
        text: 'Fourteen people came back this week. That is the company, the redesign can wait. I logged this decision with the reasoning, so in ninety days we can check if it held up.',
      },
      { from: 'me', text: 'good. log it' },
    ],
  },
]
