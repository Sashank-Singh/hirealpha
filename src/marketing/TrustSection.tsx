const PROMISES = [
  'Scoped connectors. Only the Gmail and Calendar you connect. No screen, audio, or location grab.',
  'Approval before any send or spend. A text asks first. You say go.',
  'One tap stops everything. Delete the hire and the data goes with it.',
]

export function TrustSection() {
  return (
    <section className="trust section" id="trust" aria-labelledby="trust-heading">
      <div className="container">
        <p className="deed__eyebrow">Trust</p>
        <h2 id="trust-heading">Your money and your words stay yours.</h2>
        <p className="trust__lead">
          Alpha never sends an email or spends money without your OK. Your texts are never trained
          on. Delete the hire, everything goes.
        </p>
        <ul className="trust__grid">
          {PROMISES.map((line) => (
            <li key={line} className="trust-card">
              {line}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
