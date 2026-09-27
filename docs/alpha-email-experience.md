# Alpha email brief, prototype

One surface: `/lab/brief` (`src/lab/EmailBrief.tsx` + `emailBrief.css`, mock mail in
`src/lab/labData.ts`, tokens in `src/lab/lab.css`). Route mounted in `src/App.tsx`; the
old concept paths (`/lab`, `/lab/email`, `/lab/email-v1..3`, `/lab/email-compare`) redirect
to it. Nothing here calls the API or is linked from the product UI.

## What it does

The page reads in one order at every width, because that is the order the morning actually
happens in: **the brief**, **today**, **email**, then everything else.

**The brief** is a headline and a paragraph. **Today** is the schedule, because what is
already fixed matters before what is still open: five events with times, the next one marked,
and each one opening to a line of context. The 1:00pm interview prep hands you the mail it
came from, so the schedule and the mailbox are one story rather than two lists. **Email** is
the filter row and the items. **Everything else** (the week, Alpha's rules) is folded at the
bottom.

The paragraph is three or four lines on a phone and every claim in it is derived from live
state, so it stays true after a send, a snooze or a filing: name the item with the clock,
say how many others can wait, then the overnight tally. Send the Priya thread and it reads
"Greg is the one with a clock on it" without anyone editing copy.

A mail item opens to the whole decision, so nothing has to be taken on trust and nothing
needs a second screen:

- **The mail itself:** subject, the real body text, thread count, and attachments with their
  sizes. Not a summary standing in for the mail.
- **Two chips and a promise:** the reasons that put it here (`deadline`, `you usually
  reply`, `money`), then one line of why, then what Alpha does if you ignore it. That line is
  recomputed from the live rules: turn chasing off and "I put it back in front of you, once"
  becomes "I let it close."
- **The draft reply:** editable in place, with one **Adjust** button under it. Adjust opens
  the voices (Casual, Formal, Shorter, Warmer, and Original to go back) and a box for a
  typed instruction. Picking a voice re cuts the whole draft in one tap with no typing, the
  panel stays open while you try them, and the button names the voice you are in. A typed
  instruction goes through the same machinery: ask for "more formal" and you land on the
  formal draft, not a patched one.
- **The decision:** one primary button (Send reply, Send nudge, or Bring it back, depending
  on the item's state) plus a single overflow holding Rewrite / Snooze / File / Close. The bar
  stays with you on a phone.

## The loop, and the controls

| Action | Where | What happens | Reversible |
|---|---|---|
| Send reply | Primary | Thread moves out of *need you* into *waiting on others* as a tracked follow-up; its dot on the week becomes "waiting" | Yes, with undo |
| Send nudge | Primary on waiting rows | Records itself in the row and blocks a second nudge for four days | Yes |
| Adjust | On the draft | Opens the voices and the instruction box; stays open while you try them | Adjust again |
| Casual / Formal / Shorter / Warmer | Inside Adjust | Swaps the whole draft for the same reply in that voice, instantly | Original |
| Type an instruction | Inside Adjust | Same voices, or a stated change; "more formal" lands on the formal draft | Yes |
| New drafts arrive in | Settings | Sets the default voice; re cuts every draft the reader has not chosen a voice for | Yes |
| Snooze to 4pm | Overflow | Item stays with a 4pm chip and comes back once | Yes |
| File it | Overflow | Moves to *filed quietly* as "You filed it"; its dot leaves the week | Yes, seven days |
| Close it | Overflow | Ends a waiting thread with nothing to chase | Yes |
| Bring it back | Primary on filed rows | Returns it to *need you* | Yes |
| Settings switches | Gear / folded row | Change what every item promises it will do if ignored; "send without my review" is locked off | Yes |
| Prep me | Schedule event | Marks the event prepped and says the prep sheet is in chat | Yes |

Three numbers double as filters (`need you` / `waiting on others` / `filed quietly`). **The
week** and **Alpha's rules** are folded into two header rows at the bottom; the gear in the
topbar opens the rules and scrolls to them. The week is an index, not a second surface:
tapping a dot opens that item with its mail and draft. Nothing on the surface explains
itself twice, and nothing is repeated in a footer.

## Design rules it follows

- **Phone first.** Single column, 44pt targets, safe-area padding, sticky action bar on the
  open item, two columns only from 900px.
- **The product's skin.** Colours and recipes are copied from the live surface rather than
  invented: `.mini` in `src/index.css` (`#141414`, `#f4f4f4`, `#3a3a3a`), the `--hA-*` set in
  `src/platform/homeA.css` (glass, mint `#7fe3c4`, cyan `#3fd9f5`, amber `#f4c46c`, rose
  `#ff9f9f`), Alpha's `#2a6f7a`, the row recipe from `.hA-queue .ma-row`, the glass pill from
  `.hA-action .home-action-btn`, and the section label with its mint dot from
  `.hA-section-title`.
- **House style for anything a reader sees.** The mock mail contains no hyphens and no dashes
  anywhere: not in bodies, subjects, drafts, attachment names or addresses. Em dashes are the
  clearest sign that a machine wrote a message, and a mail client cannot ship one that looks
  machine-written. Compound wording is rewritten instead ("45 minutes" rather than
  "45-minute", "signature link" rather than "e-sign link").
- **Quiet by default.** No unread counts, no notification per email, no sending as the user:
  Alpha drafts, files and watches; the send key stays human. Everything it does alone is
  listed with a reason and an undo.

## Verified behaviour

`node ~/.labshots/test.mjs` (Playwright, iPhone 13) exercises the prototype end to end and
passes 50 checks: the voices start folded behind Adjust, Adjust opens them and the
instruction box, each voice re cuts the whole draft in one tap with the active one marked and
named on the button, the panel stays open while you try them, Original restores the written
draft and clears the label, Adjust folds away again, a typed instruction lands on the same
voice, and the default voice in settings re cuts only the drafts the reader has not spoken
for; the section order is brief, then today, then email, then everything else;
the schedule lists the day, marks the next event, opens with its context, records a prep and
hands you the mail it came from; the paragraph is three or four lines and follows the live
state rather than a fixed script; the mail, the draft and the attachment are visible without hunting;
settings and rewrite options start collapsed; the open item shows exactly one primary
button; edits stick; the overflow reveals the rewriter and closes behind it; turning a rule
off changes the promise text; sending clears the item, opens a follow-up and offers undo;
undo restores it; waiting rows show the original mail and the nudge, and nudging records
itself; filed rows open their mail and can be brought back; the week starts folded, and a
week dot opens its item; snoozing marks the row.

## What was cut, and why

- **Now / Waiting / Later** and **Reply Queue** were built and reviewed alongside this one and
  cut at the reviewer's call: two organising models competing with the brief made the whole
  thing harder to understand, and the brief already carries both jobs (the state of a thread
  is visible on the item, and reply-and-go is one button).
- The **comparison page** went with them. The trade-offs it argued are kept in this document
  instead.

## Mail readability

An opened item renders the mail the way the sender built it, through the same pipeline as the
shipped reader: formatted mail keeps its sanitized HTML (images at column width, links that
open outside the app with `noopener`, lists, tables, blockquotes), plain mail is lifted into
prose with URLs autolinked by the shipped `renderRichText`. Scripts, handlers and
`javascript:` urls are stripped before render, and the lab carries a formatted sample mail so
image, link and list rendering is checked on every run.

## Voices

Every draft ships in four written voices plus the original, in `src/lab/draftTones.ts`.
They are written rather than generated on purpose: the feature being tested is the mechanism
(one tap, no typing, instant, reversible), and bending the same sentences around a thesaurus
would not tell anyone whether the drafts are good enough to send. A real build asks the model
with the thread as context and keeps the same surface: four chips, the active one named, and
Original to go back.

The settings fold carries a default voice. Changing it re cuts every draft the reader has not
already chosen a voice for, which is how a global preference should behave and is easy to
see working.

## Where it runs: the digest route

The brief is live at `/app/mini/friend/digest`, fed by the real `/api/digest` payload through
`src/lab/digestBrief.ts`, which converts it into the model the brief renders:

- **Today** comes from `meetings` (the calendar's soonest events), falling back to the
  story's beats.
- **Need you** comes from the judged mail (`story.needsYou`, with the real reason chips) plus
  the reply group, deduped by message id, with `attention` first and its real `why`.
- **Waiting on others** comes from the carry-over loops, with their due labels.
- **Filed quietly** comes from the remaining mail groups, each kept with the group it landed
  in as the reason.

The actions are the real pipeline, not mock: opening an item fetches the actual message
(`apiGetMailMessage`), Draft reply calls `apiDraftMailReply`, every voice tap is a real recut
through `apiRewriteDraft`, and Send is a two-tap confirm followed by `apiSendDraft`. The
response to Draft reply may arrive without a body; the brief handles that by recutting once,
which brings the text back with it.

`/lab/brief` still shows the same brief on mock data for design work, `/lab/brief?embed=1`
previews the embedded variant inside a copy of the mini shell, and `/app/mini/friend/digest?brief=classic`
puts the shipped brief back.

## The lab copy

`/lab/brief` renders 18 threads / 31 emails from `src/lab/labData.ts`, shaped after the real
pipeline (`MailKind` and `MailScoreReason` from `deploy/gmailHelpers.ts`, `OpenLoop` from
`src/platform/api.ts`) so the prototype argues about behaviour rather than fields.

## Open questions

- Is a fixed morning brief the right shape, or should it be reachable all day (the week index
  and the item states already assume the latter)?
- Should "if you do nothing" be a promise the product makes in writing, with a visible history
  of keeping it? That is the trust mechanism the prototype leans on hardest.
- Which items deserve to be in the brief at all? The filed pile is deliberately inspectable,
  which is cheap here and expensive at real volume.
