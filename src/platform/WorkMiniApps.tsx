import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  apiAddDecision,
  apiHoldSlot,
  apiLinearAction,
  apiListLinear,
  apiListNetwork,
  apiListPipeline,
  apiListSlots,
  apiListWorkDrafts,
  apiNextStack,
  apiPatchPipeline,
  apiSaveWorkDraft,
  apiSendDraft,
  type LinearIssue,
  type NextItem,
  type SlotOption,
  type WorkDraft,
} from './api'
import { ActionButtons, ActionRow, runAction, snoozeAction } from './ActionQueue'
import type { FeatureAuth } from './FeatureMiniApps'
import { EmailReader } from './EmailReader'

function useAuth(auth: FeatureAuth) {
  return { email: auth.email, token: auth.token, persona: auth.persona }
}

function connectHref(persona: string) {
  return `/app/hires/${persona}`
}

/* -------------------------------- Next -------------------------------- */

export function NextMoveApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [items, setItems] = useState<NextItem[]>([])
  const [connected, setConnected] = useState<string[]>([])
  const [missing, setMissing] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [doneId, setDoneId] = useState<string | null>(null)
  const [openEmailId, setOpenEmailId] = useState<string | null>(null)
  const [openEmailLabel, setOpenEmailLabel] = useState<string | undefined>(undefined)

  const load = useCallback(() => {
    apiNextStack(a)
      .then((d) => {
        setItems(d.items || [])
        setConnected(d.connected || [])
        setMissing(d.missing || [])
        setMsg('')
      })
      .catch((err) => setMsg(err instanceof Error ? err.message : 'Could not load Next.'))
  }, [a.email, a.token, a.persona])
  useEffect(() => { load() }, [load])

  const top = items[0]
  const rest = items.slice(1, 6)

  function openMail(item: NextItem) {
    setOpenEmailId(item.messageId!)
    setOpenEmailLabel(item.title)
  }

  async function doItem(item: NextItem) {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      await runAction(item, a)
      setDoneId(item.id)
      load()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not do that.')
    } finally {
      setBusy(false)
    }
  }

  async function snooze(item: NextItem) {
    if ((await snoozeAction(item, a)) === 'reload') load()
    else setItems((cur) => [...cur.slice(1), cur[0]!])
  }

  return (
    <div className="ma">
      {top ? (
        <div className={`ma-callout${top.hot ? ' ma-callout--hot' : ''}`}>
          <span className="ma-callout-kicker">{top.kicker}</span>
          <strong>{top.title}</strong>
          {top.hint && <span className="ma-sub">{top.hint}</span>}
          <div className="ma-callout-actions">
            <ActionButtons
              item={top}
              persona={auth.persona}
              busy={busy}
              done={doneId === top.id}
              onDo={(i) => void doItem(i)}
              onSnooze={(i) => void snooze(i)}
              onOpenMail={openMail}
            />
          </div>
        </div>
      ) : (
        <div className="ma-callout">
          <span className="ma-callout-kicker">Clear</span>
          <strong>Nothing is due</strong>
          <span className="ma-sub">
            {connected.length
              ? 'When mail, a meeting, or a promise lands, it shows up here.'
              : 'Connect Gmail or Calendar so Next has something to do.'}
          </span>
        </div>
      )}
      {missing.length > 0 && (
        <Link className="ma-btn ma-btn--quiet ma-btn--block" to={connectHref(auth.persona)}>
          Connect {missing.slice(0, 3).join(', ')}
        </Link>
      )}
      {msg && <p className="mini__hint">{msg}</p>}
      {rest.length > 0 && (
        <ul className="ma-list">
          {rest.map((item) => (
            <ActionRow
              key={item.id}
              item={item}
              persona={auth.persona}
              busy={busy}
              done={doneId === item.id}
              onDo={(i) => void doItem(i)}
              onOpenMail={openMail}
            />
          ))}
        </ul>
      )}
      {openEmailId && (
        <EmailReader
          messageId={openEmailId}
          label={openEmailLabel}
          auth={a}
          persona={auth.persona}
          onClose={() => { setOpenEmailId(null); setOpenEmailLabel(undefined) }}
        />
      )}
    </div>
  )
}

/* --------------------------- Approve and send -------------------------- */

export function ApproveSendApp({ auth, draftId }: { auth: FeatureAuth; draftId?: string }) {
  const a = useAuth(auth)
  const [drafts, setDrafts] = useState<WorkDraft[]>([])
  const [needConnect, setNeedConnect] = useState(false)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [sent, setSent] = useState(false)

  const load = useCallback(() => {
    apiListWorkDrafts(a)
      .then((d) => {
        setDrafts(d.drafts || [])
        setNeedConnect(!!d.needConnect)
        const next =
          (d.drafts || []).find((x) => draftId && x.id === draftId) ||
          (d.drafts || []).find((x) => x.status !== 'sent' && x.kind !== 'event')
        if (next) {
          setTo(next.toAddr)
          setSubject(next.subject)
          setBody(next.body)
        }
      })
      .catch((err) => setMsg(err instanceof Error ? err.message : 'Could not load drafts.'))
  }, [a.email, a.token, a.persona, draftId])
  useEffect(() => { load() }, [load])

  const current =
    drafts.find((d) => draftId && d.id === draftId) ||
    drafts.find((d) => d.status !== 'sent' && d.kind !== 'event')

  async function send(e: FormEvent) {
    e.preventDefault()
    if (busy || !to.trim() || !subject.trim()) return
    setBusy(true)
    setMsg('')
    try {
      let id = current?.id
      if (!id) {
        const saved = await apiSaveWorkDraft({ ...a, toAddr: to.trim(), subject: subject.trim(), body })
        id = saved.id
      }
      const res = await apiSendDraft({
        ...a,
        id,
        toAddr: to.trim(),
        subject: subject.trim(),
        body,
      })
      if (!res.ok) throw new Error(res.error || 'Send failed. Reconnect Gmail with send access.')
      setSent(true)
      load()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not send.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{sent ? 'Sent' : current ? 'Draft' : 'New'}</span>
        <span className="ma-hero-num">{sent ? 'It went' : current?.subject || 'Write it, then send'}</span>
        <span className="ma-hero-label">
          {needConnect ? 'Gmail is not connected for send.' : current?.kind === 'reply' ? 'Reply is ready. Edit, then Send.' : 'Edit, then Send. It actually goes.'}
        </span>
      </div>
      {needConnect && (
        <Link className="ma-btn ma-btn--block" to={connectHref(auth.persona)}>
          Connect Gmail
        </Link>
      )}
      <form className="ma-stack" onSubmit={send}>
        <label className="ma-label">To
          <input className="ma-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="maya@acme.com" aria-label="To" />
        </label>
        <label className="ma-label">Subject
          <input className="ma-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" />
        </label>
        <label className="ma-label">Body
          <textarea className="ma-area" rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="The mail" aria-label="Body" />
        </label>
        <button className="ma-btn ma-btn--block" type="submit" disabled={busy || !to.trim() || !subject.trim()}>
          {busy ? 'Sending' : 'Send'}
        </button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
    </div>
  )
}

/* ------------------------------ Pick a slot ---------------------------- */

export function PickSlotApp({ auth, draftId }: { auth: FeatureAuth; draftId?: string }) {
  const a = useAuth(auth)
  const [slots, setSlots] = useState<SlotOption[]>([])
  const [proposed, setProposed] = useState<WorkDraft | null>(null)
  const [needConnect, setNeedConnect] = useState(false)
  const [busy, setBusy] = useState(false)
  const [held, setHeld] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    Promise.all([
      apiListSlots(a),
      apiListWorkDrafts({ ...a, kind: 'event' }).catch(() => ({ drafts: [] as WorkDraft[] })),
    ])
      .then(([d, drafts]) => {
        setSlots(d.slots || [])
        setNeedConnect(!!d.needConnect)
        const next =
          (drafts.drafts || []).find((x) => draftId && x.id === draftId) ||
          (drafts.drafts || []).find((x) => x.status !== 'sent' && x.startAt && x.endAt)
        setProposed(next || null)
      })
      .catch((err) => setMsg(err instanceof Error ? err.message : 'Could not load times.'))
  }, [a.email, a.token, a.persona, draftId])
  useEffect(() => { load() }, [load])

  async function hold(slot: { title?: string; start: string; end: string; id?: string }) {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      const res = await apiHoldSlot({
        ...a,
        title: slot.title || proposed?.subject || 'Hold',
        start: slot.start,
        end: slot.end,
        id: slot.id,
      })
      if (!res.ok) throw new Error(res.error || 'Could not book. Connect Calendar.')
      setHeld(slot.start)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not book that time.')
    } finally {
      setBusy(false)
    }
  }

  const proposedLabel = proposed?.startAt
    ? new Date(proposed.startAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{proposed ? 'Proposed' : 'Openings'}</span>
        <span className="ma-hero-num">
          {held ? 'Booked' : proposed?.subject || slots[0]?.label || 'No openings'}
        </span>
        <span className="ma-hero-label">
          {needConnect
            ? 'Calendar is not connected.'
            : held
              ? 'Tentative is on the calendar.'
              : proposed
                ? 'Tap Book. It writes a tentative event. It is not booked until you tap.'
                : 'Tap Hold. It writes a tentative event.'}
        </span>
      </div>
      {needConnect && (
        <Link className="ma-btn ma-btn--block" to={connectHref(auth.persona)}>
          Connect Calendar
        </Link>
      )}
      {msg && <p className="mini__hint">{msg}</p>}
      {proposed && proposed.startAt && proposed.endAt && (
        <div className="ma-callout">
          <strong>{proposed.subject || 'Hold'}</strong>
          <span className="ma-sub">{proposedLabel}</span>
          <button
            className="ma-btn ma-btn--block"
            type="button"
            disabled={busy || !!held}
            onClick={() => void hold({ title: proposed.subject, start: proposed.startAt!, end: proposed.endAt!, id: proposed.id })}
          >
            {held ? 'Booked' : busy ? 'Booking' : 'Book'}
          </button>
        </div>
      )}
      <ul className="ma-list">
        {slots.map((s) => (
          <li key={s.start} className={`ma-row${held === s.start ? ' ma-row--done' : ''}`}>
            <div className="ma-row-main">
              <span className="ma-title">{s.label}</span>
              <span className="ma-sub">{s.title || '30 min'}</span>
            </div>
            <button className="ma-chip" type="button" disabled={busy} onClick={() => void hold(s)}>
              {held === s.start ? 'Held' : 'Hold'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------------------------- Linear triage ---------------------------- */

export function LinearTriageApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [issues, setIssues] = useState<LinearIssue[]>([])
  const [needConnect, setNeedConnect] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListLinear(a)
      .then((d) => {
        setIssues(d.issues || [])
        setNeedConnect(!!d.needConnect)
      })
      .catch((err) => setMsg(err instanceof Error ? err.message : 'Could not load Linear.'))
  }, [a.email, a.token, a.persona])
  useEffect(() => { load() }, [load])

  const top = issues[0]
  const rest = issues.slice(1, 10)

  async function act(id: string, action: 'done' | 'later' | 'cancel') {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      const res = await apiLinearAction({ ...a, id, action })
      if (!res.ok) throw new Error(res.error || 'Linear did not update.')
      load()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not update.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ma">
      {needConnect && (
        <Link className="ma-btn ma-btn--block" to={connectHref(auth.persona)}>
          Connect Linear
        </Link>
      )}
      {top && (
        <div className="ma-callout ma-callout--hot">
          <span className="ma-callout-kicker">{top.identifier} · {top.state || 'open'}</span>
          <strong>{top.title}</strong>
          {top.team && <span className="ma-sub">{top.team}</span>}
          <div className="ma-callout-actions">
            <button className="ma-btn" type="button" disabled={busy} onClick={() => void act(top.id, 'done')}>Done</button>
            <button className="ma-chip" type="button" disabled={busy} onClick={() => void act(top.id, 'later')}>Later</button>
            <button className="ma-chip" type="button" disabled={busy} onClick={() => void act(top.id, 'cancel')}>Not now</button>
          </div>
        </div>
      )}
      {!needConnect && !issues.length && <p className="mini__empty">No issues assigned. Linear is quiet.</p>}
      {msg && <p className="mini__hint">{msg}</p>}
      {rest.length > 0 && (
        <ul className="ma-list">
          {rest.map((i) => (
            <li key={i.id} className="ma-row">
              <div className="ma-row-main">
                <span className="ma-title">{i.title}</span>
                <span className="ma-sub">{i.identifier} · {i.state || 'open'}</span>
              </div>
              <button className="ma-chip" type="button" disabled={busy} onClick={() => void act(i.id, 'done')}>Done</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ---------------------------- Hire decision ---------------------------- */

export function HireDecisionApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [people, setPeople] = useState<Array<{ id: string; name: string; context?: string; company?: string; stage?: string }>>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [called, setCalled] = useState('')

  const load = useCallback(() => {
    Promise.all([apiListPipeline(a), apiListNetwork(a)])
      .then(([pipe, net]) => {
        const cands = (pipe.items || [])
          .filter((i) => i.stage === 'interview' || i.stage === 'offer' || /hire|candidate/i.test(i.title))
          .map((i) => ({ id: i.id, name: i.title, company: i.company, stage: i.stage, context: i.notes }))
        const extra = (net.people || [])
          .filter((p) => /candidate|hire/i.test(p.context || ''))
          .map((p) => ({ id: `n-${p.id}`, name: p.name, context: p.context }))
        setPeople(cands.length ? cands : extra)
      })
      .catch(() => setMsg('Could not load candidates.'))
  }, [a.email, a.token, a.persona])
  useEffect(() => { load() }, [load])

  const next = people[0]

  async function call(hire: boolean) {
    if (!next || busy) return
    setBusy(true)
    try {
      if (!next.id.startsWith('n-')) {
        await apiPatchPipeline({ ...a, id: next.id, stage: hire ? 'won' : 'lost' })
      }
      await apiAddDecision({
        ...a,
        persona: auth.persona,
        decision: hire ? `Hire ${next.name}` : `Pass on ${next.name}`,
        reason: next.context || next.company || '',
      })
      setCalled(hire ? 'Hired' : 'Passed')
      load()
    } catch {
      setMsg('Could not write the call.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ma">
      {next ? (
        <div className="ma-callout ma-callout--hot">
          <span className="ma-callout-kicker">{next.stage || 'Candidate'}</span>
          <strong>{next.name}</strong>
          {(next.company || next.context) && <span className="ma-sub">{next.company || next.context}</span>}
          <div className="ma-callout-actions">
            <button className="ma-btn" type="button" disabled={busy} onClick={() => void call(true)}>Hire</button>
            <button className="ma-chip" type="button" disabled={busy} onClick={() => void call(false)}>Pass</button>
          </div>
        </div>
      ) : (
        <p className="mini__empty">Add a candidate on Pipeline (interview or offer). The call writes there and to Decisions.</p>
      )}
      {called && <p className="ma-insight">{called}. Logged as a decision.</p>}
      {msg && <p className="mini__hint">{msg}</p>}
    </div>
  )
}

/* --------------------------- Investor note ----------------------------- */

export function InvestorNoteApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('Investor update')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [sent, setSent] = useState(false)

  const load = useCallback(() => {
    apiListWorkDrafts({ ...a, kind: 'investor' })
      .then((d) => {
        const note = (d.drafts || []).find((x) => x.kind === 'investor' && x.status !== 'sent')
        if (note) {
          setTo(note.toAddr)
          setSubject(note.subject)
          setBody(note.body)
        } else if (d.investorDraft) {
          setSubject(d.investorDraft.subject)
          setBody(d.investorDraft.body)
        }
      })
      .catch(() => setMsg('Could not load the note.'))
  }, [a.email, a.token, a.persona])
  useEffect(() => { load() }, [load])

  async function send(e: FormEvent) {
    e.preventDefault()
    if (busy || !to.trim() || !body.trim()) return
    setBusy(true)
    try {
      const saved = await apiSaveWorkDraft({
        ...a,
        kind: 'investor',
        toAddr: to.trim(),
        subject: subject.trim() || 'Investor update',
        body,
      })
      const res = await apiSendDraft({ ...a, id: saved.id, toAddr: to.trim(), subject, body })
      if (!res.ok) throw new Error(res.error || 'Send failed. Connect Gmail.')
      setSent(true)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not send.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{sent ? 'Sent' : 'Draft'}</span>
        <span className="ma-hero-num">{sent ? 'Update went out' : 'Investor note'}</span>
        <span className="ma-hero-label">Generated from pipeline, spend, and decisions. Edit, then Send.</span>
      </div>
      <form className="ma-stack" onSubmit={send}>
        <label className="ma-label">To
          <input className="ma-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="investors@, bcc list" aria-label="To" />
        </label>
        <label className="ma-label">Subject
          <input className="ma-input" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
        </label>
        <textarea className="ma-area" rows={10} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Note" />
        <button className="ma-btn ma-btn--block" type="submit" disabled={busy || !to.trim() || !body.trim()}>
          {busy ? 'Sending' : 'Send'}
        </button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
    </div>
  )
}
