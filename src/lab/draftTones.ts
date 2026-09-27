import type { Tone } from './labData'

/* Tone variants for every draft in the brief.
 *
 * These are written, not generated: each one is a full, sendable reply in that
 * voice, so tapping "Formal" or "Casual" swaps the whole draft for something a
 * person would actually send rather than bending the same sentences. A real
 * build would ask the model with the thread as context; the prototype keeps the
 * mechanism honest by shipping the words.
 *
 * House style still applies: no hyphens, no dashes, nothing that reads machine
 * written. Amounts and dates stay factual in every tone.
 */
export const TONE_LABEL: Record<Tone, string> = {
  plain: 'As written',
  casual: 'Casual',
  formal: 'Formal',
  shorter: 'Shorter',
  warmer: 'Warmer',
}

export const DRAFT_TONES: Record<string, Partial<Record<Tone, string>>> = {
  /* Priya: interview slots, the one with a clock on it. */
  t1: {
    formal:
      'Dear Priya,\n\nThank you for the prompt reply. Thursday at 10:00am suits me well.\n\nI am also available on Friday at 2:00pm should that be more convenient for the engineers.\n\nKind regards,\nMaya',
    casual:
      'Hi Priya,\n\nThanks for coming back so quickly. Thursday at 10 works for me.\n\nFriday at 2 is free as well if that suits the engineers better.\n\nThanks,\nMaya',
    shorter: 'Hi Priya,\n\nThursday 10:00am works. Friday 2:00pm also works if that is easier.\n\nMaya',
    warmer:
      'Hi Priya,\n\nThank you for coming back so quickly, and for holding a slot while you waited on me. Thursday 10:00am works well on my end.\n\nFriday 2:00pm is open too if the engineers prefer it. I am looking forward to meeting them.\n\nBest,\nMaya',
  },

  /* Marcus: the room booking. */
  t2: {
    formal:
      'Dear Marcus,\n\nFriday at 9:30am is confirmed on my side. Please go ahead and book the room.\n\nShould the board session overrun again, do let me know and I will rearrange my morning.\n\nKind regards,\nMaya',
    casual: 'Hey Marcus,\n\nFriday 9:30 is good. Book it.\n\nIf the board runs long, just shout and I will shuffle things.\n\nMaya',
    shorter: 'Hey Marcus,\n\nFriday 9:30 works. Book the room.\n\nMaya',
    warmer:
      'Hey Marcus,\n\nFriday 9:30 works for me, and no worries about the shuffle. Book the room.\n\nIf the board runs long again, ping me and I will make it work on my side.\n\nMaya',
  },

  /* Greg: the lease question before signing. */
  t3: {
    formal:
      'Dear Greg,\n\nThank you for sending this through. Before I sign, could you confirm whether the parking space remains included on unchanged terms?\n\nIf so, I will return the signed copy before the weekend.\n\nKind regards,\nMaya',
    casual: 'Hi Greg,\n\nThanks for this. Quick one before I sign: is parking still included at the same price?\n\nIf so you will have it before the weekend.\n\nMaya',
    shorter: 'Hi Greg,\n\nIs parking still included at no change? If so I will sign before the weekend.\n\nMaya',
    warmer:
      'Hi Greg,\n\nThank you for getting this over to me, and for the warning about the link closing. One question before I sign: is the parking space still included at no change?\n\nIf so, you will have it back before the weekend.\n\nMaya',
  },

  /* Sarah: notes on her draft. */
  t4: {
    formal:
      'Dear Sarah,\n\nOf course. Please send the draft through and I will return notes by Thursday evening, concentrating on the opening and the overall arc rather than line edits.\n\nIf it would help, I am free for a thirty minute call on Friday morning.\n\nKind regards,\nMaya',
    casual:
      'Sarah,\n\nYes, send it over. You will have notes by Thursday evening, mostly on the opening and the arc, not line edits.\n\nHappy to talk it through Friday morning too if that is easier.\n\nMaya',
    shorter: 'Sarah,\n\nYes, send it. Notes by Thursday evening, on the opening and the arc.\n\nMaya',
    warmer:
      'Sarah,\n\nYes, send it over. I am glad you asked, and twenty minutes of notes is nothing between us. You will have them by Thursday evening, focused on the opening and the arc.\n\nIf it is easier, let us talk it through on Friday morning.\n\nMaya',
  },

  /* Jules: the headcount. */
  t5: {
    formal: 'Count me in, two of us. Please let me know what to bring.\n\nMaya',
    casual: 'In, two of us.\n\nWhat should I bring?\n\nMaya',
    shorter: 'In, two of us.\n\nMaya',
    warmer:
      'In, and bringing one. Happy birthday in advance. Tell me what to bring and I will sort it.\n\nMaya',
  },

  /* Nudges. Same shape, same rules: the thread is the context. */
  t6: {
    formal:
      'Dear Professor Alvarez,\n\nI hope you will forgive the follow up. The portal closes on September 28 and I wanted to be sure my earlier note reached you.\n\nEverything is prepared on my side, so submitting would take a single link and roughly ten minutes.\n\nWith thanks and best wishes,\nMaya',
    casual:
      'Hi Professor Alvarez,\n\nJust floating this back up in case it got buried. The portal closes September 28.\n\nEverything is ready on my end, so it is one link and about ten minutes.\n\nThanks,\nMaya',
    shorter:
      'Dear Professor Alvarez,\n\nThe portal closes September 28. Everything is ready on my side if you are able to submit.\n\nWith thanks,\nMaya',
    warmer:
      'Dear Professor Alvarez,\n\nI hope the semester is treating you kindly. I am writing once more only because the portal closes on September 28.\n\nEverything is prepared on my side, and I would be very grateful for your support. It is a single link and about ten minutes.\n\nWith thanks,\nMaya',
  },
  t7: {
    formal:
      'Dear Dana,\n\nInvoice 204 is now nine days beyond the net 7 terms, and I note this is the second consecutive cycle in which payment has slipped.\n\nCould you confirm a payment date today? I am happy to resend the invoice to your accounts team if that is easier.\n\nI would like to keep the work moving, but this balance does need to clear.\n\nKind regards,\nMaya',
    casual:
      'Hi Dana,\n\nInvoice 204 is nine days over the net 7 terms now, and it slipped last cycle too.\n\nCan you give me a payment date today? Happy to send it to whoever handles AP.\n\nI want to keep things moving, but I need this one cleared.\n\nMaya',
    shorter: 'Hi Dana,\n\nInvoice 204 is nine days past terms. Could you confirm a payment date today?\n\nMaya',
    warmer:
      'Hi Dana,\n\nI hope things are well with you. Invoice 204 is nine days past the net 7 terms now, and it slipped last cycle as well, so I wanted to flag it rather than let it drift.\n\nCould you confirm a payment date today? I am happy to send it to whoever handles AP.\n\nMaya',
  },
  t8: {
    formal:
      'Dear Dana,\n\nI hope you do not mind me following up. I remain glad to be introduced whenever it suits you and your platform lead.\n\nKind regards,\nMaya',
    casual: 'Dana, no rush. Just bumping this in case it slipped through. Still up for meeting them whenever.\n\nMaya',
    shorter: 'Dana, still happy to meet them whenever suits.\n\nMaya',
    warmer:
      'Dana, no rush at all, I know how these weeks go. Just floating this back up in case it slipped through.\n\nI am still very happy to meet them whenever it is convenient for you both.\n\nMaya',
  },
  t9: {
    formal:
      'Dear support team,\n\nI am writing to follow up on ticket 88214. The two day response window has passed and the next invoice is due on Friday.\n\nCould someone confirm the seat count before then?\n\nKind regards,\nMaya',
    casual:
      'Hi again,\n\nJust chasing ticket 88214. The two days you promised have passed and the next invoice runs Friday.\n\nCan someone confirm the seat count before then?\n\nThanks,\nMaya',
    shorter: 'Hi,\n\nChasing ticket 88214. Can someone confirm the seat count before Friday?\n\nThanks,\nMaya',
    warmer:
      'Hi there,\n\nI know these queues get long, so no stress at all. I am chasing ticket 88214 because the two days you promised have passed and the next invoice runs Friday.\n\nIf someone could confirm the seat count before then, that would help a lot.\n\nThanks,\nMaya',
  },
}
