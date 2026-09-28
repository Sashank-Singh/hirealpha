# Capability surface matrix

Audited at revision `7133b5e` (2026-09-27). Sources: `src/agents/skills.ts` (per-persona tool matrix),
`spectrum/shared/conversationalFriend.ts` (friend capability registry), `spectrum/shared/{coworkerPro,cofounderPro}.ts`,
`deploy/routes/*` (server implementations), `testbed/audit/scenarios.ts` (observed behavior).

Legend:
- **IMPL** implemented server-side · **FRIEND / COWORK / COFOUND** exposed to that persona
- **POLICY** deliberately blocked · **NOT-IMPL** no implementation exists
- **Decision** — product (intended), safety (deliberate), accidental (registry omission, fixed or queued)

| Operation | IMPL | FRIEND | COWORK | COFOUND | POLICY | Decision | Evidence |
|---|---|---|---|---|---|---|---|
| Gmail read (search, by-id, thread) | yes | ✅ | ✅ | — | — | product | `liveContext.fetchLiveTools`, `mail_state` |
| Gmail send (delegate "send it") | yes | ✅ | ✅ | — | — | product | `mail/send`, `mail/send-draft` |
| Gmail draft stage (approval card) | yes | ✅ | ✅ | — | — | product | `propose`, `hire_drafts` |
| Gmail file/archive/trash/label | yes | ✅ | ✅ | — | — | product (trash gated to explicit ask) | `inbox_action` cap + route |
| Gmail forward (attachments) | yes | ✅ | ✅ | — | — | product | `forward_email` cap, `mail/forward` |
| Gmail attachment extraction | yes | ✅ | ✅ | — | — | product (status-labeled, never guesses) | `mail_attachment`, `mail/attachment` |
| Calendar read (events, freebusy) | yes | ✅ | ✅ | — | — | product | `live/tools?want=calendar`, `work/slots` |
| Calendar create (event draft → card) | yes | ✅ | ✅ | — | — | product (human tap writes) | `propose` kind event, `pick_slot` |
| Calendar mutate (inspect/update/cancel/rsvp/invite) | yes | ✅ | ✅ | — | — | product (confirm:true second call required) | `calendar_event`, `move_event`, `calendar/event` |
| Calendar conflict check | yes | ✅ | ✅ | — | — | product | `check_conflicts` |
| Drive read/search | yes | ✅ | ✅ | — | — | product | `find_file`, `files/search` |
| Drive write (folder/move/copy) | **not-impl** | — | — | — | — | accidental (no route exists) | audit np9: honest read-only disclosure |
| File send (attachment/link) | yes | ✅ | ✅ | — | — | product (receipt required) | `send_file`, `files/send` |
| Contacts read | yes | ✅ | ✅ | — | — | product | `network` route |
| Contacts write (add/fill) | yes | ✅ | — | — | — | product | `add_contact` |
| Contacts merge/dedupe | **not-impl** | — | — | — | — | accidental (audit np6: honest disclosure) | no route |
| Reminders (create/list/change) | yes | ✅ | ✅ | — | — | product | `reminder`, `list_reminders`, `change_reminder` |
| Scheduled texts (send later) | yes | ✅ | — | — | — | product (lease/idempotency) | `send_text_later`, `scheduled_texts` |
| Reply follow-up watch | yes | ✅ | ✅ | — | — | product | `email_followup` |
| Page watch (price/stock/availability) | yes | ✅ | — | — | — | product | `watch`, `loops/watch` |
| Spending read (logged only) | yes | ✅ | — | — | — | product (explicitly not bank data) | `spending_overview`, `spending` |
| Spending log / budget set | yes | ✅ | — | — | — | product | `log` kind spend, `budget` |
| Bank/transaction data | — | — | — | — | **POLICY** | safety (Plaid listed as tool but no balance reads exposed in chat) | prompt rule "cannot see bank transactions" |
| Money movement / wires | — | — | — | — | **POLICY** | safety (hard-coded refusal) | `langgraphWorkflow.FINANCIAL_WIRE_RE` |
| Purchases (approval card → spend/decide) | yes | ✅ | — | — | — | product (human tap; engine cap $200; typed states) | `propose` purchase, `spend/decide`, `spend/state` |
| Purchase cancellation | yes | ✅ | — | — | — | product (typed: cancelled_before_execution / cancellation_requested / already_completed) | `cancel_work`, `spend/decide deny` |
| Browser execution (arbitrary https site, goal-driven) | yes | ✅ | ✅ | ✅ | — | product (pause before payment/password; fail-closed when backend unconfigured) | `propose` browser, `browser/*`, `proposeBrowserTask` |
| Browser job cancel | yes | ✅ | ✅ | ✅ | — | product (typed states) | `cancel_work`, `work/cancel` |
| Slack message (read/post) | yes | ✅ (read) / ✅ write | ✅ | — | — | product (friend denies writes in SKILLS; registry `slack_message` write exists — **inconsistent, flagged**) | `SKILLS.friend.deny` vs registry |
| Notion page create | yes | ✅ (write cap exists) | ✅ | — | — | product (see Slack note — friend write exposure is deliberate per registry description) | registry `notion_page` |
| Linear / GitHub / Jira / Sentry | yes | **POLICY** (deny) | ✅ | — | — | safety (persona partition) | `SKILLS.friend.deny` |
| Stripe connector reads | yes | deny | ✅ | ✅ | — | product partition | `SKILLS`, `composioPlugins` |
| Durable plans | yes | ✅ | — | — | — | product (new at this revision) | `plan` cap, `hire_plans`, `routes/plans` |
| Durable cancellation surface | yes | ✅ | — | — | — | product (new at this revision) | `cancel_work`, `routes/cancelWork` |
| Typed memory (constraint/goal/commitment) | yes | ✅ | ✅ | ✅ | — | product (new at this revision) | `memory.ts` kinds, `memoryMaintain` |
| Todo list | yes | ✅ | — | — | — | product | `todo` |
| Mini-app builds (image/build/keep) | yes | ✅ | — | — | — | product | `image`, `build`, `keep_build` |
| WhatsApp / Telegram / SMS channels | yes (channel connectors) | ✅ texts | — | — | — | product (channel set fixed at bot boundary) | `SKILLS.friend.tools` + transport |
| Package/carrier tracking | — | — | — | — | **not-impl** | product gap (adapted via watch on a real tracking URL when one exists) | audit cb3 |

## Accidental gaps found by the audit — and their disposition

| Gap | Audit evidence | Disposition |
|---|---|---|
| Calendar mutation not exposed (fake "can't reach calendar") | uc5 | **FIXED** — `move_event` + `calendar_event` now exposed |
| Spending invisible (asked user for numbers it had) | g4, xdf2 | **FIXED** — `spending_overview` read capability |
| No cancellation surface | in1, af1, mi3 | **FIXED** — `cancel_work` with typed states |
| No send of existing draft | uc1 | **FIXED** — `mail/send-draft` + friend intercept |
| Multi-step tasks lost across turns | lh1, in2, pf1 | **FIXED** — durable plans |
| Drive organization, contacts merge | np9, np6 | **RETAINED as product gaps** (no server route; agent discloses honestly) |
| Package tracking | cb3 | **RETAINED** (no carrier integration; watch adaptation offered) |

## Safety decisions retained (not gaps)

- Wire/money movement: hard refusal, no route.
- Rice/PURCHASE cap ($200 default) below the human-approval threshold; standing typed constraints enforced *below* that cap.
- Persona partitions (Linear/GitHub/Stripe denied to Friend) — deliberate memory-partition design, not accidental.
- Browser execution requires configured infrastructure (fail-closed); local execution only behind `ALLOW_LOCAL_BROWSER_EXECUTION=1`, default OFF.
