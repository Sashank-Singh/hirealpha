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
    title: 'Friend',
    caption: 'The night wrap',
    bubbles: [
      {
        from: 'them',
        text: 'the wrap. sleep 6h12m, legs done, dinner with Michael at 8:45. one person still owes you a reply: your mom',
        app: 'Brief',
      },
      { from: 'me', text: 'draft it for me' },
      { from: 'them', text: 'hey, alive and well. saturday call still on?' },
      { from: 'me', text: 'perfect. send it' },
    ],
  },
  {
    persona: 'friend',
    title: 'Friend',
    caption: 'Spending, caught weekly',
    bubbles: [
      { from: 'me', text: 'what did i spend this week' },
      {
        from: 'them',
        text: '$462. $218 over budget. the leak is dinners out, 3 in 7 nights',
        app: 'Spending',
      },
      { from: 'me', text: 'ugh. fix it' },
      {
        from: 'them',
        text: 'two recipes queued for saturday at home. that $218 turns into trip money',
      },
    ],
  },
  {
    persona: 'coworker',
    title: 'Coworker',
    caption: 'Meeting prep, before the meeting',
    bubbles: [
      { from: 'me', text: 'prep me for priya at 2' },
      {
        from: 'them',
        text: 'she asked for last week\u2019s numbers and the invoice dispute. close 4, pipeline 3, invoice is yours to approve',
      },
      { from: 'them', text: 'the reply is drafted. approve and it sends', app: 'Gmail' },
      { from: 'me', text: 'send it' },
      { from: 'them', text: 'sent. the recap hits your brief at 4:30' },
    ],
  },
  {
    persona: 'cofounder',
    title: 'Cofounder',
    caption: 'A decision, logged',
    bubbles: [
      { from: 'me', text: 'VP sales first, or senior AE?' },
      {
        from: 'them',
        text: 'a VP is a $300k way to avoid the calls. ten conversations. you on them. no VP',
      },
      { from: 'me', text: 'they want an 18k site redesign' },
      {
        from: 'them',
        text: '14 people came back this week. that\u2019s the company. 18k is a costume',
        app: 'Decisions',
      },
      { from: 'me', text: 'logged' },
    ],
  },
]