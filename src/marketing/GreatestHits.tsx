import { HIGHLIGHTS } from '../data/highlights'
import { AlphaFace } from '../AlphaFace'
import type { AgentId } from '../agents/types'

const PERSONA_COLOR: Record<AgentId, string> = {
  friend: '#1f7a6e',
  coworker: '#2b5ea7',
  cofounder: '#8a4b1f',
}

const PERSONA_NAME: Record<AgentId, string> = {
  friend: 'Alpha',
  coworker: 'Alpha (Coworker)',
  cofounder: 'Alpha(CoFounder)',
}

/** What texting a hire looks like: a wall of sample threads, rendered as
 * iPhone screens so the product demos itself. Seed content lives in
 * src/data/highlights.ts and is illustrative; swap in real screenshots there
 * as they arrive. */
export function GreatestHits() {
  return (
    <section className="hits section" id="hits" aria-labelledby="hits-heading">
      <div className="container">
        <div className="hits__head">
          <p className="hits__eyebrow">In the thread</p>
          <h2 id="hits-heading">Texting a hire looks like this.</h2>
          <p>Sample threads in the product's voice. The real ones go up here as they happen — with consent, lightly edited.</p>
        </div>
        <div className="hits__grid">
          {HIGHLIGHTS.map((t) => {
            const lastMine = t.bubbles[t.bubbles.length - 1]?.from === 'me'
            return (
              <article key={`${t.persona}-${t.caption}`} className="hits__card" aria-label={`Sample iMessage thread with ${PERSONA_NAME[t.persona]}`}>
                <div className="hits__status" aria-hidden="true">
                  <span>9:41</span>
                  <span className="hits__signal" />
                </div>
                <header className="hits__card-head">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                    <path d="M15 6l-6 6 6 6" stroke="#0b84fe" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="hits__avatar">
                    <AlphaFace color={PERSONA_COLOR[t.persona]} mood="soft" size={34} />
                  </span>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="#0b84fe" aria-hidden="true">
                    <path d="M4 6h11a2 2 0 0 1 2 2v3.2l3-2.4v6.4l-3-2.4V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
                  </svg>
                </header>
                <p className="hits__contact">{PERSONA_NAME[t.persona]}</p>
                <p className="hits__meta">iMessage · Encrypted</p>
                <p className="hits__meta">Today 9:41 AM</p>
                <ul className="hits__thread" role="list">
                  {t.bubbles.map((b, i) => (
                    <li
                      key={i}
                      className={`hits__bubble hits__bubble--${b.from}`}
                      aria-label={`${b.from === 'me' ? 'You' : PERSONA_NAME[t.persona]}: ${b.text}`}
                    >
                      {b.app && <span className="hits__app">{b.app}</span>}
                      {b.text}
                    </li>
                  ))}
                </ul>
                {lastMine && <p className="hits__delivered">Delivered</p>}
                <div className="hits__composer" aria-hidden="true">
                  <span className="hits__plus">+</span>
                  <span className="hits__field">iMessage</span>
                  <span className="hits__mic" />
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
