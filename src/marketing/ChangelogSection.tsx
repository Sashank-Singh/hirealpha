import { CHANGELOG } from './changelog'

export function Changelog() {
  return (
    <section className="changelog section" id="changelog" aria-labelledby="changelog-heading">
      <div className="container">
        <p className="deed__eyebrow">Changelog</p>
        <h2 id="changelog-heading">What they learned this week.</h2>
        <ul className="changelog__list">
          {CHANGELOG.map((entry) => (
            <li key={`${entry.date}-${entry.text}`} className="changelog__item">
              <span className="changelog__date">{entry.date}</span>
              <p>
                <strong>{entry.who}:</strong> {entry.text}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
