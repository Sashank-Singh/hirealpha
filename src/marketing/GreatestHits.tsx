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

/** What texting a hire looks like: the same .phone frame the hero plays on,
 * static per thread. Seed content lives in src/data/highlights.ts; swap in
 * real screenshots there as they arrive. */
export function GreatestHits() {
  return (
    <section className="hits section" id="hits" aria-labelledby="hits-heading">
      <div className="container">
        <div className="hits__head">
          <p className="hits__eyebrow">In the thread</p>
          <h2 id="hits-heading">Texting a hire looks like this.</h2>
          <p>Sample threads in the product\u2019s voice. The real ones go up here as they happen \u2014 with consent, lightly edited.</p>
        </div>
        <div className="hits__grid">
          {HIGHLIGHTS.map((t) => {
            const lastMine = t.bubbles[t.bubbles.length - 1]?.from === 'me'
            return (
              <figure key={`${t.persona}-${t.caption}`} className="hits__figure">
                <div className="phone" aria-label={`Sample iMessage thread with ${PERSONA_NAME[t.persona]}`}>
                  <div className="phone__bezel">
                    <div className="phone__screen">
                      <div className="ios-status">
                        <span className="ios-status__time">9:41</span>
                        <span className="ios-status__island" aria-hidden="true" />
                      </div>
                      <div className="thread-bar">
                        <button type="button" className="thread-back" aria-label="Back to Messages" tabIndex={-1}>
                          <svg viewBox="0 0 12 20" width="10" height="16" aria-hidden="true">
                            <path d="M10 2L2 10l8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="thread-back__count">68</span>
                        </button>
                        <div className="thread-who">
                          <AlphaFace color={PERSONA_COLOR[t.persona]} mood="soft" size={42} />
                          <div className="thread-who__text">
                            <strong>{PERSONA_NAME[t.persona]}</strong>
                          </div>
                        </div>
                        <button type="button" className="thread-facetime" aria-label="FaceTime" tabIndex={-1}>
                          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
                            <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h7A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 16.5v-9zm13.2 2.1 3.3-2.2a.8.8 0 0 1 1.3.7v7.8a.8.8 0 0 1-1.3.7l-3.3-2.2v-4.8z" />
                          </svg>
                        </button>
                      </div>
                      <div className="thread-body">
                        <p className="thread-secure">
                          iMessage<span aria-hidden="true">\u00b7</span>Encrypted
                        </p>
                        <p className="thread-stamp">Today 9:41 AM</p>
                        <ul className="hits__thread" role="list">
                          {t.bubbles.map((b, i) => (
                            <li
                              key={i}
                              className={`bubble bubble--${b.from} hits__bubble`}
                              aria-label={`${b.from === 'me' ? 'You' : PERSONA_NAME[t.persona]}: ${b.text}`}
                            >
                              {b.app && <span className="hits__app">{b.app}</span>}
                              {b.text}
                            </li>
                          ))}
                        </ul>
                        {lastMine && <p className="thread-delivered">Delivered</p>}
                      </div>
                      <div className="thread-composer">
                        <button type="button" className="composer-plus" aria-hidden="true" tabIndex={-1}>
                          <svg viewBox="0 0 24 24" width="28" height="28">
                            <circle cx="12" cy="12" r="11" fill="#8e8e93" />
                            <path d="M12 7v10M7 12h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        </button>
                        <div className="composer-field">
                          <span>iMessage</span>
                          <button type="button" className="composer-mic" aria-hidden="true" tabIndex={-1}>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="#8e8e93">
                              <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <figcaption className="hits__caption">{t.caption}</figcaption>
              </figure>
            )
          })}
        </div>
      </div>
    </section>
  )
}
