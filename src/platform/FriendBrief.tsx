import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiDraftMailReply, apiPrepFor, apiRewriteDraft, type ReplyDraft } from './api'
import type { FeatureAuth } from './FeatureMiniApps'
import { friendBriefModel, mailLabel, type BriefMail, type FriendBriefData } from './friendBriefModel'
import { isOpenableMail } from './briefMail'
import './friendBrief.css'

type Props = {
  data: FriendBriefData | null
  evening?: boolean
  auth: FeatureAuth
  updatedAt: number
  refreshing: boolean
  refreshError?: string
  onRefresh: () => Promise<void>
  href: (kind: string) => string
  onSettings: () => void
  onOpenMail: (id: string, label: string, snippet?: string) => void
  onOpenDraft: (id: string, label: string, snippet: string | undefined, draft: ReplyDraft) => void
}

export function FriendBrief({ data, evening = false, auth, updatedAt, refreshing, refreshError, onRefresh, href, onSettings, onOpenMail, onOpenDraft }: Props) {
  const builtAt = data?.generatedAt || updatedAt
  const elapsedMinutes = builtAt ? Math.max(0, (Date.now() - builtAt) / 60_000) : 0
  const model = friendBriefModel(data ?? {}, evening, elapsedMinutes)
  const [busy, setBusy] = useState<string | null>(null)
  const pendingAction = useRef(false)
  const [error, setError] = useState('')
  const [prep, setPrep] = useState<{ title: string; text: string } | null>(null)
  const [mailOpen, setMailOpen] = useState(false)
  const [allMeetings, setAllMeetings] = useState(false)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const prepRef = useRef<HTMLElement>(null)
  useEffect(() => { if (prep) { prepRef.current?.focus(); prepRef.current?.scrollIntoView({ block: 'nearest' }) } }, [prep])
  const first = model.mail[0]
  const next = model.meetings[0]
  const completedHabits = model.habits.filter(h => h.done)
  const hasWin = model.wins.length > 0 || completedHabits.length > 0
  const date = data?.date || new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const needsConnection = !model.calendarKnown

  async function draft(item: BriefMail) {
    if (pendingAction.current) return
    pendingAction.current = true
    setBusy(item.id)
    setError('')
    try {
      const result = await apiDraftMailReply({ ...auth, id: item.id })
      if (!result.ok) throw new Error(result.error || 'Could not write a reply. Try again.')
      if (!result.id || !result.toAddr) throw new Error('The reply has no recipient. Open the message to reply there.')
      let body = result.body
      if (!body) {
        const rewritten = await apiRewriteDraft({ ...auth, id: result.id, instruction: 'Return the current reply draft.' })
        if (!rewritten.ok || !rewritten.body) throw new Error(rewritten.error || 'The draft is not ready. Try again.')
        body = rewritten.body
      }
      onOpenDraft(item.id, item.label, item.snippet, { id: result.id, toAddr: result.toAddr, subject: result.subject, body })
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not write a reply. Try again.') }
    finally { pendingAction.current = false; setBusy(null) }
  }

  async function prepare(title: string) {
    if (pendingAction.current) return
    pendingAction.current = true
    setBusy('prep'); setError('')
    try {
      const result = await apiPrepFor({ ...auth, name: title })
      if (!result.ok || !result.text) throw new Error(result.error || 'Could not prepare this event. Try again.')
      setPrep({ title, text: result.text })
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not prepare this event. Try again.') }
    finally { pendingAction.current = false; setBusy(null) }
  }

  function mailRow(item: BriefMail) {
    const { sender, subject } = mailLabel(item.label)
    return <li key={item.id} className="fb-mail-row">
      <span className="fb-initial" aria-hidden="true">{sender.slice(0, 1)}</span>
      <div><span className="fb-sender">{sender}</span><strong>{subject}</strong>{item.snippet && <p>{item.snippet}</p>}</div>
      {isOpenableMail(item.id) && <div className="fb-mail-actions"><button className="fb-text-button" onClick={() => onOpenMail(item.id, item.label, item.snippet)} aria-label={`Read ${subject}`}>Read <span aria-hidden="true">↗</span></button>{model.mail.some(m => m.id === item.id) && <button className="fb-text-button" disabled={!!busy} onClick={() => void draft(item)} aria-label={`Draft a reply to ${sender}`}>{busy === item.id ? 'Writing…' : 'Reply'}</button>}</div>}
    </li>
  }

  return <main className={`fb${evening ? ' fb--evening' : ''}`}>
    <div className="fb-toolbar">
      <nav className="fb-switch" aria-label="Your daily briefs">
        <Link to={href('digest')} aria-current={!evening ? 'page' : undefined}>Morning</Link>
        <Link to={href('pick_night')} aria-current={evening ? 'page' : undefined}>Evening</Link>
      </nav>
      <button className="fb-refresh" disabled={refreshing || refreshBusy} onClick={async () => {
        setRefreshBusy(true); setError('')
        try { await onRefresh() } catch { setError('Could not refresh. Please try again.') } finally { setRefreshBusy(false) }
      }} aria-label="Refresh brief"><span aria-hidden="true">↻</span> {refreshing || refreshBusy ? 'Updating…' : 'Refresh'}</button>
    </div>

    <header className="fb-hero">
      <div className="fb-orbit" aria-hidden="true"><span className="fb-sun" /><span className="fb-horizon" /></div>
      <p className="fb-eyebrow">{date}</p>
      <h1>{evening ? <>Leave the day<br /><em>here.</em></> : <>A little clarity.<br /><em>A day that’s yours.</em></>}</h1>
      <p className="fb-intro">{evening ? 'A moment to wrap up. Then, something for you.' : 'What’s ahead, what needs you, and room for everything else.'}</p>
      {data?.weather && <p className="fb-weather">{data.weather.temp}°{data.weather.unit} <span>· {data.weather.condition}</span></p>}
    </header>

    {(error || refreshError) && <div className="fb-error" role="alert">{error || refreshError}{error && <button onClick={() => setError('')} aria-label="Dismiss error">×</button>}</div>}
    {data?.pending && <p className="fb-note" role="status">Still updating. You’re seeing what’s available so far.</p>}

    <div className="fb-layout">
      <div className="fb-primary">
        {evening ? <section className="fb-focus fb-wrap" aria-labelledby="fb-focus-title">
          <span className="fb-eyebrow">The good in today</span>
          <h2 id="fb-focus-title">{hasWin ? 'That counts.' : 'No score. Just your day.'}</h2>
          {model.wins.length ? <ul className="fb-wins">{model.wins.map(win => <li key={win.key}><span aria-hidden="true">✓</span><div><strong>{win.label}</strong>{win.detail && <p>{win.detail}</p>}</div></li>)}</ul> : !hasWin && <p className="fb-focus-copy">{model.earlier.length ? model.earlier.join(' · ') : 'No completed activities in this brief yet. A day is more than a checklist.'}</p>}
          {completedHabits.length > 0 && <div className="fb-habits">{completedHabits.map(h => <span key={h.id}>{h.emoji} {h.name}</span>)}</div>}
          <Link className="fb-button" to={href('tonight')}>Find something for tonight <span aria-hidden="true">↗</span></Link>
        </section> : <section className="fb-focus" aria-labelledby="fb-focus-title">
          <span className="fb-eyebrow">{first ? 'One place to start' : next ? 'Coming up' : model.mailFailed ? 'Mail needs another look' : 'A little breathing room'}</span>
          <h2 id="fb-focus-title">{first ? mailLabel(first.label).subject : next ? next.title : model.mailFailed ? 'We couldn’t check your mail.' : 'Start with what matters to you.'}</h2>
          {first ? <>
            <p className="fb-from">{mailLabel(first.label).sender} <span>· {first.reason || 'For your attention'}</span></p>
            {first.snippet && <p className="fb-focus-copy">{first.snippet}</p>}
            {isOpenableMail(first.id) ? <div className="fb-actions"><button className="fb-button" disabled={!!busy} onClick={() => void draft(first)}>{busy === first.id ? 'Writing your draft…' : 'Help me reply'} <span aria-hidden="true">↗</span></button><button className="fb-text-button" onClick={() => onOpenMail(first.id, first.label, first.snippet)}>Read first</button></div> : <Link className="fb-button" to={href('open_loops')}>See your open tasks <span aria-hidden="true">↗</span></Link>}
            {isOpenableMail(first.id) && <p className="fb-assurance">You review the reply before anything sends.</p>}
          </> : next ? <><p className="fb-focus-copy">{next.time} · On your calendar</p>{next.prep ? <button className="fb-button" disabled={!!busy} onClick={() => void prepare(next.title)}>{busy === 'prep' ? 'Getting you ready…' : 'Help me get ready'} <span aria-hidden="true">↗</span></button> : <a className="fb-button" href="#fb-agenda">See your day <span aria-hidden="true">↘</span></a>}</> : <><p className="fb-focus-copy">{model.mailFailed ? 'Your inbox didn’t answer, so this brief can’t tell what needs a reply.' : model.mailStatus === 'not_connected' ? 'Connect Gmail to see what needs a reply.' : 'No priority mail surfaced in this brief.'}{needsConnection ? ' Connect your calendar to see what’s ahead.' : ' Take a look at your plans, or make a little time for yourself.'}</p>{model.mailStatus === 'auth_expired' || model.mailStatus === 'not_connected' || needsConnection ? <button className="fb-button" onClick={onSettings}>Check connections <span aria-hidden="true">↗</span></button> : model.mailFailed ? <button className="fb-button" disabled={refreshing || refreshBusy} onClick={() => void onRefresh()}>Try mail again <span aria-hidden="true">↻</span></button> : <Link className="fb-button" to={href('tonight')}>Find something to look forward to <span aria-hidden="true">↗</span></Link>}</>}
        </section>}

        {prep && <section ref={prepRef} tabIndex={-1} className="fb-prep" aria-label="Event preparation" role="status"><div className="fb-section-head"><h2>{prep.title}</h2><button className="fb-text-button" onClick={() => setPrep(null)}>Close</button></div><p>{prep.text}</p></section>}

        <section className="fb-mail" aria-labelledby="fb-mail-title">
          <div className="fb-section-head"><h2 id="fb-mail-title">{evening ? 'Needs a reply' : 'Also on your radar'}</h2><span>{evening ? model.mail.length : Math.max(0, model.mail.length - 1)}</span></div>
          {(evening ? model.mail : model.mail.slice(1)).length ? <ul>{(evening ? model.mail : model.mail.slice(1)).slice(0, mailOpen ? undefined : 3).map(mailRow)}</ul> : <p className="fb-empty">{model.mailFailed ? 'Mail could not be checked right now.' : model.mailStatus === 'not_connected' ? 'Connect Gmail in Settings to see your mail.' : evening ? 'No replies identified in this brief.' : 'No other priority mail in this brief.'}</p>}
          {(evening ? model.mail.length : model.mail.length - 1) > 3 && <button className="fb-text-button fb-more" onClick={() => setMailOpen(!mailOpen)}>{mailOpen ? 'Show less' : `See all ${evening ? model.mail.length : model.mail.length - 1} messages`} <span aria-hidden="true">{mailOpen ? '−' : '+'}</span></button>}
          {model.otherMail.length > 0 && <details className="fb-details"><summary>{evening ? 'Recent and sorted mail' : 'Other mail'} <span>{model.otherMail.length} {model.otherMail.length === 1 ? 'message' : 'messages'}</span></summary><ul>{model.otherMail.map(mailRow)}</ul></details>}
        </section>
      </div>

      <aside className="fb-secondary" aria-label={evening ? 'Tomorrow and open tasks' : 'Your day ahead'}>
        <section className="fb-agenda" id="fb-agenda">
          <div className="fb-section-head"><h2>{evening ? 'A peek at tomorrow' : 'Your day ahead'}</h2><span aria-hidden="true">↗</span></div>
          {evening ? model.tomorrow.length ? <ul className="fb-lines">{model.tomorrow.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="fb-empty">{needsConnection ? 'Connect your calendar to see tomorrow.' : model.calendarStatus === 'auth_expired' ? <>Reconnect your calendar to see tomorrow. <button className="fb-text-button" onClick={onSettings}>Reconnect</button></> : model.calendarFailed ? 'Could not check tomorrow’s calendar.' : 'Nothing on the calendar tomorrow.'}</p> : <>
            {needsConnection ? <p className="fb-empty">Your calendar isn’t connected. <button className="fb-text-button" onClick={onSettings}>Connect it</button></p> : model.meetings.length ? <ol className="fb-timeline">{model.meetings.slice(0, allMeetings ? undefined : 4).map((meeting, i) => <li key={`${meeting.time}-${i}`}><time>{meeting.time}</time><div><strong>{meeting.title}</strong>{meeting.prep && <button className="fb-text-button" disabled={!!busy} onClick={() => void prepare(meeting.title)}>{busy === 'prep' ? 'Preparing…' : 'Get ready'} <span aria-hidden="true">↗</span></button>}</div></li>)}</ol> : model.calendarLines.length ? <ul className="fb-lines">{model.calendarLines.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="fb-empty">{model.calendarStatus === 'auth_expired' ? <>Reconnect your calendar to see your day. <button className="fb-text-button" onClick={onSettings}>Reconnect</button></> : model.calendarFailed ? 'Could not check your calendar. Try refreshing.' : 'No upcoming events in this brief. A little room to breathe.'}</p>}
            {model.meetings.length > 4 && <button className="fb-text-button" onClick={() => setAllMeetings(!allMeetings)}>{allMeetings ? 'Show less' : `See all ${model.meetings.length} events`}</button>}
          </>}
        </section>

        {model.loops.length > 0 && <section className="fb-loops"><div className="fb-section-head"><h2>{evening ? 'Still open. Still okay.' : 'Worth remembering'}</h2></div><ul className="fb-lines">{model.loops.slice(0, 3).map(loop => <li key={loop.id}>{loop.title}{loop.dueLabel && <small>{loop.dueLabel}</small>}</li>)}</ul><Link className="fb-text-button" to={href('open_loops')}>Review open tasks{model.loops.length > 3 ? ` (${model.loops.length})` : ''} <span aria-hidden="true">↗</span></Link></section>}
        {evening && model.tonightTasks.length > 0 && <section className="fb-loops"><h2>Needs you tonight</h2><ul className="fb-lines">{model.tonightTasks.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
        {evening && model.eveningPlans.length > 0 && <section className="fb-loops"><h2>On tonight</h2><ul className="fb-lines">{model.eveningPlans.map((line, i) => <li key={i}>{line}</li>)}</ul></section>}
        {!evening && !!data?.story?.factLine?.length && <details className="fb-details fb-checkin"><summary>Your check-in</summary><ul className="fb-lines">{data.story.factLine.map(fact => <li key={fact.key}>{fact.openKind ? <Link className="fb-text-button" to={href(fact.openKind)}>{fact.text} <span aria-hidden="true">↗</span></Link> : fact.text}</li>)}</ul></details>}
        <div className="fb-signoff"><span aria-hidden="true">✳</span><p>{evening ? 'You don’t have to finish everything to call it a day.' : 'Your day belongs to you. This is just a head start.'}</p></div>
      </aside>
    </div>
    <footer className="fb-footer"><span>{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Your daily brief'}</span><Link to={href('home')}>Back to your day <span aria-hidden="true">↗</span></Link></footer>
  </main>
}
