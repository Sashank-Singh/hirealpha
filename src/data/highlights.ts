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
        text: "day's wrapped. slept 6ish, legs done, michael at 8:45. also your mom still never got that reply",
      },
      { from: 'me', text: 'draft it for me' },
      { from: 'them', text: '"hey mom! still good for our call saturday?"' },
      { from: 'them', text: "short, because that's how you two text. say the word and it goes" },
      { from: 'me', text: 'perfect, send it' },
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
        text: "$462. that's $218 over. it's the dinners out, 3 in 7 nights",
      },
      { from: 'me', text: 'ugh. fix it' },
      {
        from: 'them',
        text: 'two easy recipes queued for saturday. that $218 just became trip money',
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
        text: "she wants last week's numbers and the invoice update. you're at 4 closed this week, 3 more live",
      },
      {
        from: 'them',
        app: 'Gmail',
        text: 'invoice reply is drafted. nothing sends till you tap',
      },
      { from: 'me', text: 'send it' },
      { from: 'them', text: 'done. recap hits your brief at 4:30' },
    ],
  },
  {
    persona: 'cofounder',
    title: 'Alpha(CoFounder)',
    caption: 'A decision, captured and logged',
    bubbles: [
      { from: 'me', text: 'vp sales first, or senior ae?' },
      { from: 'them', text: 'no vp. 300k to avoid the calls' },
      { from: 'them', text: "ten convos, you on them. that's the hire" },
      { from: 'me', text: 'they also want 18k for a site redesign' },
      {
        from: 'them',
        app: 'Decisions',
        text: "14 people came back this week. that's the company. logged it, we check in 90 days",
      },
      { from: 'me', text: 'good. log it' },
    ],
  },
]
