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

/** What texting a hire looks like: a wall of sample threads, rendered like
 * iMessage so the product demos itself. Seed content lives in
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
          {HIGHLIGHTS.map((t) => (
            <article key={`${t.persona}-${t.caption}`} className="hits__card">
              <header className="hits__card-head">
                <AlphaFace color={PERSONA_COLOR[t.persona]} mood="soft" size={30} />
                <div>
                  <strong>{PERSONA_NAME[t.persona]}</strong>
                  <span>{t.caption}</span>
                </div>
              </header>
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
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}