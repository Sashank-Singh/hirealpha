import { useState } from 'react'
import { AlphaFace } from '../AlphaFace'
import { LAB_ROUTES } from './labRoutes'
import './lab.css'
import './emailConceptCompare.css'

/* /lab/concept-compare — the decision page for this concept set.
 *
 * Thumbnails are live iframes of the real routes, scaled down, so this page can
 * never drift from what the prototypes actually render.
 */

const CONCEPTS = [
  {
    id: 'v1',
    href: LAB_ROUTES.v1,
    name: 'C1 · Now / Waiting / Later',
    short: 'Now / Waiting / Later',
    oneLine: 'Every thread is in one of three states. The user works a state, not a list.',
  },
  {
    id: 'v2',
    href: LAB_ROUTES.v2,
    name: 'C2 · Reply Queue',
    short: 'Reply Queue',
    oneLine: 'One card at a time, draft pre-written, one key to send. Sending opens a follow-up.',
  },
  {
    id: 'v3',
    href: LAB_ROUTES.v3,
    name: 'C3 · Morning Brief + Radar',
    short: 'Brief + Radar',
    oneLine: 'A written brief you read once, and a seven-day radar Alpha re-walks all day.',
  },
]

/* The eight things the brief asked every prototype to show, and how each
 * concept answers it. */
const REQUIREMENTS: { label: string; v1: string; v2: string; v3: string }[] = [
  {
    label: 'Important email surfaced clearly',
    v1: 'Now is a state, not a badge — importance is the whole layout.',
    v2: 'The queue is one card; the top card is by definition the most important.',
    v3: 'The written lead names the one or two things that matter before anything is listed.',
  },
  {
    label: 'Concise summary',
    v1: 'Alpha’s sentence is the headline; the subject line is demoted to metadata.',
    v2: '“They are asking for …” states the request with the greeting stripped off.',
    v3: 'A three-paragraph read covering all 31 emails.',
  },
  {
    label: 'Why it matters',
    v1: 'A bordered why-block on every Now card, plus reason chips.',
    v2: 'A per-card “Why is this here?” with the score and the exact signals behind it.',
    v3: '“If you do nothing” on every radar entry — consequence, not description.',
  },
  {
    label: 'Suggested next action',
    v1: 'One named action per card with the consequence spelled out underneath.',
    v2: 'The action is the card: send, skip, or later.',
    v3: 'One button per radar entry, plus the auto-behaviour if you ignore it.',
  },
  {
    label: 'Draft or reply option',
    v1: 'Full thread reading, editable draft, alternate angles.',
    v2: 'Draft first, thread on request; alternate angles and a rewrite instruction box.',
    v3: 'Draft available from the radar entry, not pushed at you.',
  },
  {
    label: 'Waiting-on-others tracking',
    v1: 'A first-class state: days waited, the line you set, one nudge draft per thread.',
    v2: 'Opened automatically the moment you send; lives in the rail.',
    v3: 'Expected replies sit on the radar next to deadlines.',
  },
  {
    label: 'Handled quietly / noise',
    v1: 'Filed piles with a reason per item and a Bring back button.',
    v2: 'A “kept out of your queue” count with the reasons, always visible.',
    v3: 'A filed-overnight expander under the brief.',
  },
  {
    label: 'Trust / autopilot settings',
    v1: 'Rules rail with today’s ledger and three hard limits in writing.',
    v2: 'A four-rung autonomy ladder with a progress gate before Alpha may send anything.',
    v3: 'Interruption-policy toggles plus an honest broken-connection state.',
  },
]

const OUTCOMES = [
  {
    key: 'miss',
    label: 'Never miss something important',
    weight: '×1.5',
    v1: 5,
    v2: 4,
    v3: 5,
    note: 'C2 hides whatever is not in the queue — safest at the centre, riskiest at the edges until the scoring is trusted.',
  },
  {
    key: 'speed',
    label: 'Reply faster',
    weight: '×1.5',
    v1: 3,
    v2: 5,
    v3: 3,
    note: 'C2 removes navigation entirely: one card, one key, next card.',
  },
  {
    key: 'follow',
    label: 'Track follow-ups',
    weight: '×1',
    v1: 5,
    v2: 4,
    v3: 4,
    note: 'C1 owns a Waiting state with your own line; C2 opens follow-ups as a side-effect of sending.',
  },
  {
    key: 'calm',
    label: 'Reduce inbox anxiety',
    weight: '×1',
    v1: 4,
    v2: 4,
    v3: 5,
    note: 'C3’s “everything else is already moving” is the calmest sentence in the set.',
  },
  {
    key: 'trust',
    label: 'Build trust in Alpha',
    weight: '×1',
    v1: 4,
    v2: 5,
    v3: 4,
    note: 'C2’s ladder plus per-card reasons plus undo is the strongest trust story; C3’s honesty about broken connections is the best failure story.',
  },
]

const WEIGHTS: Record<string, number> = { miss: 1.5, speed: 1.5, follow: 1, calm: 1, trust: 1 }

function totals() {
  const out: Record<string, number> = { v1: 0, v2: 0, v3: 0 }
  for (const o of OUTCOMES) {
    out.v1! += o.v1 * WEIGHTS[o.key]!
    out.v2! += o.v2 * WEIGHTS[o.key]!
    out.v3! += o.v3 * WEIGHTS[o.key]!
  }
  return { v1: Math.round(out.v1! * 10) / 10, v2: Math.round(out.v2! * 10) / 10, v3: Math.round(out.v3! * 10) / 10 }
}

const PROS_CONS = [
  {
    id: 'v1',
    pros: [
      'The only model where “where is that email?” has a one-word answer, forever.',
      'Waiting is a real state with a clock, a line you set, and a nudge history — follow-ups stop living in your head.',
      'Filing always carries a reason and an undo, which is what makes quiet handling acceptable in the first place.',
    ],
    cons: [
      'Three states is a mental model to teach, and the switching cost shows up on every visit.',
      'It is still a list: the user browses rather than being served.',
      'Reply speed is only marginally better than a good inbox — the draft sits one click deeper.',
    ],
  },
  {
    id: 'v2',
    pros: [
      'Fastest path from “I should deal with email” to done, and it is measurable in minutes.',
      'Sending immediately creates a tracked follow-up, so the loop closes without the user doing anything extra.',
      'The autonomy ladder gives a real answer to “will it send something without me?”',
      'Builds on primitives already in the repo: mail scoring, drafting, rewrite instructions, send, and open loops.',
    ],
    cons: [
      'A queue hides the rest of the mailbox — comfortable once scoring is trusted, alarming before that.',
      'Skip is a deferral, not a decision; the skip pile needs a home, which is what C1’s Later state provides.',
      'Batch replying can feel mechanical if the copy is not genuinely warm.',
    ],
  },
  {
    id: 'v3',
    pros: [
      'The strongest “email is handled” feeling of the three — you read it once and close the tab.',
      'The radar is the only surface here that prevents missed deadlines rather than reporting them.',
      'Interruption policy plus the honest broken-connection line is the best trust framing.',
    ],
    cons: [
      'A ritual depends on a habit. Miss the 7:30 window and the whole thing reads as stale.',
      'By the time you are reading a radar entry, replying is three steps deep.',
      'A radar only earns credibility with weeks of history — it needs the other two first.',
    ],
  },
]

const ROLLOUT = [
  {
    tag: 'MVP 1',
    name: 'Reply Queue',
    window: 'Ship as the only email surface',
    items: [
      'One queue of threads that need a reply, capped at 7, served one card at a time.',
      'A draft on every card, alternate angles, rewrite-by-instruction, and a 10-second undo on send.',
      'Every send opens a follow-up with a return date and one nudge draft.',
      'A visible “kept out of your queue” count with reasons, and the four-rung autonomy ladder ending at “Alpha cannot send as you”.',
    ],
    why: 'It is the thinnest thing that proves the promise — fewer minutes, nothing dropped — and it reuses mail scoring, drafting, rewrite, send and the loops engine that already ship.',
  },
  {
    tag: 'MVP 1.5',
    name: 'Now / Waiting / Later, as the shell',
    window: 'Once users trust the scoring',
    items: [
      'Promote the queue into the Now state; make Waiting first-class with your line and nudge history.',
      'Give Later the filed-pile treatment: a reason per item, a Bring back button, and the seven-day undo.',
      'Add the rules rail and today’s ledger so quiet handling is inspectable at a glance.',
      'Retire the skip pile — skipped cards land in Later with a reason instead of vanishing.',
    ],
    why: 'The queue needs somewhere for deferred mail to live, and users need to see the whole mailbox the moment they stop believing a single score.',
  },
  {
    tag: 'MVP 2',
    name: 'Morning Brief + Radar',
    window: 'After four to six weeks of history',
    items: [
      'A written brief at a fixed morning time, in the app and as one chat message.',
      'The seven-day radar over real deadline and expected-reply history, re-walked through the day.',
      'Interruption-policy toggles, quiet hours, and the honest partial-scan states.',
      'Prep sheets for calendar events, reusing the existing brief machinery.',
    ],
    why: 'A radar with no history is a guess, and a brief that repeats what the queue already said is noise. Both need the queue to have been running for a while first.',
  },
]

const NEVER = [
  'No unread counts. Anywhere. Ever.',
  'No folder tree, no labels, no hand-filing by drag and drop.',
  'No notification per email — one chat message a day at most, and the brief itself never notifies.',
  'No sending as the user. Alpha drafts, files and watches; the send key stays human.',
  'No silent action. Everything Alpha does alone is listed with a reason and an undo.',
]

export function EmailConceptCompare() {
  const [active, setActive] = useState<string>('all')
  const t = totals()
  const shown = CONCEPTS.filter((c) => active === 'all' || c.id === active)

  return (
    <div className="lab lc">
      <div className="lc-shell">
        <header className="lab-topbar">
          <AlphaFace color="#2a6f7a" mood="soft" size={34} />
          <div className="lab-brand">
            <div className="lab-brand__name">Alpha email experience — three concepts</div>
            <div className="lab-brand__role">Prototype review · mock data · nothing wired to production</div>
          </div>
          <div className="lab-topbar__spacer" />
          <span className="lab-badge">Comparison</span>
        </header>

        <section className="lc-intro">
          <h1 className="lab-display lc-intro__title">Make email feel handled, calm, and assistant-driven.</h1>
          <p className="lc-intro__sub">
            All three concepts answer the same brief: never miss something that matters, reply faster than an inbox
            allows, track what you are owed, and make Alpha’s autonomy legible enough to trust. They differ in what the
            user is actually looking at — a state, a stack, or a story.
          </p>
          <ul className="lc-refuse">
            {NEVER.slice(0, 3).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>

        <nav className="lc-filter" aria-label="Filter prototypes">
          {[{ id: 'all', name: 'All three' }, ...CONCEPTS.map((c) => ({ id: c.id, name: `C${c.id.slice(1)}` }))].map((f) => (
            <button
              key={f.id}
              type="button"
              className={`lc-filter__btn${active === f.id ? ' is-active' : ''}`}
              aria-pressed={active === f.id}
              onClick={() => setActive(f.id)}
            >
              {f.name}
            </button>
          ))}
        </nav>

        {/* ── Live prototypes ───────────────────────────────────────────── */}
        <section className={`lc-previews${active !== 'all' ? ' is-single' : ''}`}>
          {shown.map((c) => (
            <article key={c.id} className="lc-preview">
              <header className="lc-preview__head">
                <div>
                  <h2 className="lc-preview__name">{c.name}</h2>
                  <p className="lab-note lc-preview__line">{c.oneLine}</p>
                </div>
                <a className="lab-btn lab-btn--sm" href={c.href} target="_blank" rel="noreferrer">
                  Open ↗
                </a>
              </header>
              <div className="lc-thumb">
                <iframe className="lc-thumb__frame" src={c.href} title={`${c.name} live preview`} loading="lazy" tabIndex={-1} />
              </div>
              <p className="lab-note lc-preview__caption">
                Live render of <code>{c.href}</code> — not a screenshot, so the thumbnail cannot drift from the prototype.
              </p>
            </article>
          ))}
        </section>

        {/* ── Requirement coverage ─────────────────────────────────────── */}
        <section className="lc-section">
          <header className="lc-section__head">
            <span className="lab-kicker">Coverage</span>
            <h2 className="lab-title">All three show the same eight things — differently</h2>
          </header>
          <div className="lc-matrix">
            <div className="lc-matrix__row lc-matrix__row--head">
              <span />
              <span>C1 Now/Waiting/Later</span>
              <span>C2 Reply Queue</span>
              <span>C3 Brief + Radar</span>
            </div>
            {REQUIREMENTS.map((r) => (
              <div key={r.label} className="lc-matrix__row">
                <span className="lc-matrix__label">{r.label}</span>
                <span>{r.v1}</span>
                <span>{r.v2}</span>
                <span>{r.v3}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Scorecard ────────────────────────────────────────────────── */}
        <section className="lc-section">
          <header className="lc-section__head">
            <span className="lab-kicker">Scorecard</span>
            <h2 className="lab-title">Scored against the two things the brief actually asked for</h2>
            <p className="lab-note lc-section__note">
              “Never miss something important” and “reply faster” carry 1.5× weight because that is the promise in the
              goal. The scores are a judgement call, not a measurement — they exist to be argued with.
            </p>
          </header>

          <div className="lc-scores">
            {OUTCOMES.map((o) => (
              <div key={o.key} className="lc-score">
                <div className="lc-score__label">
                  {o.label}
                  <span className="lc-score__weight">{o.weight}</span>
                </div>
                <div className="lc-score__bars">
                  {(['v1', 'v2', 'v3'] as const).map((k) => (
                    <div key={k} className="lc-score__bar">
                      <span className="lc-score__key">C{k.slice(1)}</span>
                      <span className="lc-score__track">
                        <span className={`lc-score__fill lc-score__fill--${k}`} style={{ width: `${((o[k] as number) / 5) * 100}%` }} />
                      </span>
                      <span className="lc-score__num lab-num">{o[k]}</span>
                    </div>
                  ))}
                </div>
                <p className="lab-note lc-score__note">{o.note}</p>
              </div>
            ))}
            <div className="lc-totals">
              {(['v1', 'v2', 'v3'] as const).map((k) => (
                <div key={k} className={`lc-total${k === 'v2' ? ' is-winner' : ''}`}>
                  <span className="lc-total__key">C{k.slice(1)}</span>
                  <span className="lc-total__num lab-num">{t[k]}</span>
                  <span className="lab-note">weighted total · 25 max</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Pros and cons ────────────────────────────────────────────── */}
        <section className="lc-section">
          <header className="lc-section__head">
            <span className="lab-kicker">Pros and cons</span>
            <h2 className="lab-title">Where each concept is strong, and what it costs</h2>
          </header>
          <div className="lc-proscons">
            {PROS_CONS.map((p) => {
              const concept = CONCEPTS.find((c) => c.id === p.id)!
              return (
                <article key={p.id} className="lc-pc">
                  <header className="lc-pc__head">
                    <span className={`lc-pc__key lc-pc__key--${p.id}`}>{p.id.toUpperCase().replace('V', 'C')}</span>
                    <span className="lc-pc__name">{concept.short}</span>
                  </header>
                  <div className="lc-pc__cols">
                    <div className="lc-pc__col">
                      <span className="lab-kicker lc-pc__good">Worth it</span>
                      <ul>
                        {p.pros.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="lc-pc__col">
                      <span className="lab-kicker lc-pc__bad">Costs</span>
                      <ul>
                        {p.cons.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        {/* ── Recommendation ───────────────────────────────────────────── */}
        <section className="lc-section lc-rec">
          <header className="lc-section__head">
            <span className="lab-kicker">Recommendation</span>
            <h2 className="lab-display lc-rec__title">Ship the Reply Queue first, wearing the state model, and earn the brief.</h2>
            <p className="lc-rec__body">
              The Reply Queue is the only one of the three that makes the promise measurable on day one — fewer minutes in
              email, nothing dropped — while keeping the send key human. But a queue on its own has nowhere to put a
              skipped thread and no way to prove nothing is hiding, so MVP 1 also carries a minimal version of C1’s
              Waiting list and the “kept out of your queue” accounting. The full three-state shell (MVP 1.5) is what makes
              the product legible once people trust the scoring, and the brief only becomes a ritual worth building
              (MVP 2) when the radar has real history behind it.
            </p>
            <p className="lc-rec__body lc-rec__body--em">
              The order matters for one reason: trust is earned by review, then spent on autonomy. Level 3 on the ladder
              should not exist until level 2 has a month of reviewed sends behind it — the prototypes show that gate
              rather than hiding it.
            </p>
          </header>

          <ol className="lc-rollout">
            {ROLLOUT.map((r) => (
              <li key={r.tag} className="lc-step">
                <div className="lc-step__head">
                  <span className="lc-step__tag">{r.tag}</span>
                  <span className="lc-step__name">{r.name}</span>
                  <span className="lab-note lc-step__window">{r.window}</span>
                </div>
                <ul className="lc-step__items">
                  {r.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
                <p className="lc-step__why">{r.why}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lc-section">
          <header className="lc-section__head">
            <span className="lab-kicker">Guardrails</span>
            <h2 className="lab-title">What MVP 1 must not do, whichever concept wins</h2>
          </header>
          <ul className="lc-never">
            {NEVER.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>

        <footer className="lc-foot">
          <span className="lab-note">
            Prototypes: <code>{LAB_ROUTES.v1}</code> · <code>{LAB_ROUTES.v2}</code> · <code>{LAB_ROUTES.v3}</code>. All
            data is mock — no API calls, no account access.
          </span>
          <a className="lab-btn lab-btn--sm" href={LAB_ROUTES.v2}>
            Open the recommended concept →
          </a>
        </footer>
      </div>
    </div>
  )
}
