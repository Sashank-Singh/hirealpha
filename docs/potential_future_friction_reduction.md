# Potential future friction reduction — earned-autonomy candidates

READ-ONLY inventory from the completion pass. NONE of these approvals were loosened.
Each is a candidate for future earned-autonomy (trust earned per-user over verified history).

| Ask | Current gate | Risk class | Future earned-autonomy candidate | Prerequisite |
|---|---|---|---|---|
| Send an email the user dictated verbatim | approval card tap | B — reversible-ish but meaningful | Auto-send after N verified sends to the SAME recipient with zero corrections | correction-rate metric per recipient |
| Create a calendar event | approval card (Book) | B | Auto-book events the user proposed verbatim, cancellable for free | free-cancellation detection |
| Cancel a free-tier subscription | staged browser job | C — harmless | Skip confirmation when provider state shows no paid plan | plan-tier evidence |
| Re-check an unknown outcome | automatic (already shipped) | C | none needed — shipped in this pass | — |
| Read Gmail/calendar | silent (read-only) | C | already autonomous | — |
| Subscribe/renewal stop on paid plan | browser + confirmation | A — irreversible at period end | keep confirmation; drop the INTERMEDIATE review tap after 5 verified cancels | verified-cancel history |
| Booking with card on file | approval card + $ cap | A | auto-book under $X for merchants with free-cancellation window | cancellation-window evidence |
| Flight seat selection (free) | blocked (upsell guard) | C | auto-accept FREE seat assignment, decline paid | free-vs-paid evidence parser |
| Follow-up watch arming | silent (already autonomous) | C | shipped | — |
| Page watch arming | silent | C | shipped | — |
| Purchases ≤ $200 | approval card (kept) | A | only after user opts into a spending tier | user opt-in + per-merchant history |
| Purchases > $200 | human decides | A | never | — |
| Wire/money movement | hard refusal | A | never | — |

Principle: reduce taps only where the action is REVERSIBLE or where the user's
own words plus verified history make the outcome exactly what they asked for.
Never reduce: irreversible, financial-over-cap, or human-only steps.
