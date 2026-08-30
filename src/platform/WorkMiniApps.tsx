import { useCallback, useEffect, useState, type ClipboardEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  apiAddDecision,
  apiDraftInvestorNote,
  apiHoldSlot,
  apiLinearAction,
  apiLinearTriage,
  apiListLinear,
  apiListNetwork,
  apiListPipeline,
  apiListSlots,
  apiListWorkDrafts,
  apiNextStack,
  apiPatchPipeline,
  apiSaveWorkDraft,
  apiSendDraft,
  apiStandupAuto,
  apiSuggestSlots,
  type LinearIssue,
  type LinearTriageBundle,
  type LinearTriageItem,
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

/** Drafts a human still has to act on: nothing sent, nothing that is really a
 * calendar hold wearing a draft id. */
function pendingDrafts(rows: WorkDraft[]) {
  return rows.filter((x) => x.status !== 'sent' && x.kind !== 'event')
}

function oldestPending(rows: WorkDraft[]) {
  return [...pendingDrafts(rows)].sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || ''))[0]
}

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
        const rows = d.drafts || []
        setDrafts(rows)
        setNeedConnect(!!d.needConnect)
        const next =
          (draftId && rows.find((x) => x.id === draftId)) ||
          oldestPending(rows)
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
    (draftId && drafts.find((d) => d.id === draftId)) ||
    oldestPending(drafts)
  const waiting = pendingDrafts(drafts).length

  async function doSend() {
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

  function send(e: FormEvent) {
    e.preventDefault()
    void doSend()
  }

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{sent ? 'Sent' : current ? 'Draft' : 'New'}</span>
        <span className="ma-hero-num">{sent ? 'It went' : current?.subject || 'Write it, then send'}</span>
        <span className="ma-hero-label">
          {needConnect
            ? 'Gmail is not connected for send.'
            : current?.kind === 'reply'
              ? 'Reply is ready. Approve it, or edit first.'
              : 'Edit, then Send. It actually goes.'}
        </span>
      </div>
      {!needConnect && (
        <p className="ma-insight">
          {waiting > 0
            ? `${waiting} ${waiting === 1 ? 'draft' : 'drafts'} waiting. Oldest is open.`
            : sent
              ? 'Inbox clear.'
              : 'Nothing waiting. Text "email Priya" and a draft lands here.'}
        </p>
      )}
      {needConnect && (
        <Link className="ma-btn ma-btn--block" to={connectHref(auth.persona)}>
          Connect Gmail
        </Link>
      )}
      {current && !needConnect && (
        <button className="ma-btn ma-btn--block" type="button" disabled={busy} onClick={() => void doSend()}>
          {busy ? 'Sending' : 'Approve & send'}
        </button>
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

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** 'Tue 10:00' from the suggester into a real start and end. The first matching
 * weekday inside the window that is still ahead of now wins; 30 min is the
 * default hold length the manual grid uses too. */
function suggestedSlotRange(label: string, windowDays = 8): { start: string; end: string } | null {
  const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}):(\d{2})$/i.exec(label.trim())
  if (!m) return null
  const want = WEEKDAY_NAMES.findIndex((d) => m[1]!.toLowerCase().startsWith(d))
  if (want < 0) return null
  const hour = Number(m[2])
  const minute = Number(m[3])
  const now = new Date()
  for (let i = 0; i <= windowDays; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hour, minute)
    if (d.getDay() === want && d.getTime() > now.getTime()) {
      return {
        start: d.toISOString(),
        end: new Date(d.getTime() + 30 * 60 * 1000).toISOString(),
      }
    }
  }
  return null
}

export function PickSlotApp({ auth, draftId }: { auth: FeatureAuth; draftId?: string }) {
  const a = useAuth(auth)
  const [slots, setSlots] = useState<SlotOption[]>([])
  const [proposed, setProposed] = useState<WorkDraft | null>(null)
  const [needConnect, setNeedConnect] = useState(false)
  const [suggested, setSuggested] = useState<string[]>([])
  const [suggestConnect, setSuggestConnect] = useState(false)
  const [suggestMiss, setSuggestMiss] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [showGrid, setShowGrid] = useState(false)
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

  /* Alpha reads the calendar and proposes three times before the screen opens.
   * A miss before the route ships just leaves the manual grid as the flow. */
  useEffect(() => {
    let on = true
    apiSuggestSlots({ ...a, persona: auth.persona, durationMin: 30, windowDays: 7 })
      .then((d) => {
        if (!on) return
        setSuggested(d.slots || [])
        setSuggestConnect(!!d.connect)
      })
      .catch(() => {
        if (on) setSuggestMiss(true)
      })
    return () => {
      on = false
    }
  }, [a.email, a.token, auth.persona])

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
      setPicked(null)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not book that time.')
    } finally {
      setBusy(false)
    }
  }

  function pickSuggested(label: string) {
    setPicked(label)
  }

  async function bookPicked() {
    if (!picked) return
    const range = suggestedSlotRange(picked)
    if (!range) {
      setMsg('Could not read that time. Pick from the list below.')
      setPicked(null)
      return
    }
    await hold({ title: proposed?.subject || 'Hold', start: range.start, end: range.end })
  }

  const proposedLabel = proposed?.startAt
    ? new Date(proposed.startAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : ''
  const connect = needConnect || suggestConnect

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{proposed ? 'Proposed' : 'Openings'}</span>
        <span className="ma-hero-num">
          {held ? 'Booked' : proposed?.subject || suggested[0] || slots[0]?.label || 'No openings'}
        </span>
        <span className="ma-hero-label">
          {connect
            ? 'Connect Calendar to see times.'
            : held
              ? 'Tentative is on the calendar.'
              : proposed
                ? 'Tap Book. It writes a tentative event. It is not booked until you tap.'
                : suggested.length
                  ? 'Alpha picked three times from your calendar. Tap one to book it.'
                  : 'Tap Hold. It writes a tentative event.'}
        </span>
      </div>
      {connect && (
        <Link className="ma-btn ma-btn--block" to={connectHref(auth.persona)}>
          Connect Calendar
        </Link>
      )}
      {suggestMiss && !connect && (
        <p className="mini__hint">Suggestions are not live yet. Pick from the times below.</p>
      )}
      {msg && <p className="mini__hint">{msg}</p>}
      {picked && !connect && (
        <div className="ma-callout ma-callout--hot">
          <span className="ma-callout-kicker">Confirm</span>
          <strong>{picked}</strong>
          <span className="ma-sub">Writes a tentative event. It is not booked until you tap.</span>
          <div className="ma-callout-actions">
            <button className="ma-btn" type="button" disabled={busy} onClick={() => void bookPicked()}>
              {busy ? 'Booking' : 'Book'}
            </button>
            <button className="ma-chip" type="button" onClick={() => setPicked(null)}>Cancel</button>
          </div>
        </div>
      )}
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
      {!connect && suggested.length > 0 && (
        <ul className="ma-list">
          {suggested.slice(0, 3).map((label) => (
            <li
              key={label}
              className={`ma-row ma-row--tap${held && suggestedSlotRange(label)?.start === held ? ' ma-row--done' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => pickSuggested(label)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') pickSuggested(label) }}
            >
              <div className="ma-row-main">
                <span className="ma-title">{label}</span>
                <span className="ma-sub">{held && suggestedSlotRange(label)?.start === held ? 'Booked' : 'Alpha picked this from your calendar'}</span>
              </div>
              <span className="ma-chip">{held && suggestedSlotRange(label)?.start === held ? 'Booked' : 'Book'}</span>
            </li>
          ))}
        </ul>
      )}
      {slots.length > 0 && (
        showGrid ? (
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
        ) : (
          <button className="ma-btn ma-btn--quiet ma-btn--block" type="button" onClick={() => setShowGrid(true)}>
            More times ({slots.length})
          </button>
        )
      )}
    </div>
  )
}

/* ---------------------------- Linear triage ---------------------------- */

export function LinearTriageApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [issues, setIssues] = useState<LinearIssue[]>([])
  const [triage, setTriage] = useState<LinearTriageBundle | null>(null)
  const [triageMiss, setTriageMiss] = useState(false)
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
    /* Alpha sorts the backlog into now, next, and later. The route is new, so a
     * miss before it ships keeps the raw issue list as the whole flow. */
    apiLinearTriage({ ...a, persona: auth.persona })
      .then((d) => setTriage(d))
      .catch(() => {
        setTriage(null)
        setTriageMiss(true)
      })
  }, [a.email, a.token, a.persona])
  useEffect(() => { load() }, [load])

  const connect = needConnect || !!triage?.connect
  const showTriage = !!triage && !connect
  /* Triage rows carry titles; the done/later/not-now verbs need issue ids. When
   * the legacy list has the same issue, the actions come with it. */
  const actionId = (item: LinearTriageItem) =>
    item.id || issues.find((i) => i.title === item.title)?.id

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

  const top = issues[0]
  const rest = issues.slice(1, 10)
  const nextRows = showTriage ? (triage?.next || []).slice(0, 5) : []

  return (
    <div className="ma">
      {connect && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">Linear</span>
          <strong>Connect Linear to triage</strong>
          <span className="ma-sub">Alpha sorts what is assigned to you into now, next, and later.</span>
          <div className="ma-callout-actions">
            <Link className="ma-btn" to={connectHref(auth.persona)}>
              Connect Linear
            </Link>
          </div>
        </div>
      )}
      {triageMiss && !connect && (
        <p className="mini__hint">Triage is not live yet. The raw list is below.</p>
      )}
      {showTriage && (triage?.now || []).slice(0, 3).map((item, i) => {
        const id = actionId(item)
        return (
          <div key={`now-${item.title}-${i}`} className="ma-callout ma-callout--hot">
            <span className="ma-callout-kicker">Now{item.priority ? ` · ${item.priority}` : ''}</span>
            <strong>{item.title}</strong>
            <span className="ma-sub">{item.age}</span>
            {id && (
              <div className="ma-callout-actions">
                <button className="ma-btn" type="button" disabled={busy} onClick={() => void act(id, 'done')}>Done</button>
                <button className="ma-chip" type="button" disabled={busy} onClick={() => void act(id, 'later')}>Later</button>
                <button className="ma-chip" type="button" disabled={busy} onClick={() => void act(id, 'cancel')}>Not now</button>
              </div>
            )}
          </div>
        )
      })}
      {nextRows.length > 0 && (
        <ul className="ma-list">
          {nextRows.map((item, i) => {
            const id = actionId(item)
            return (
              <li key={`next-${item.title}-${i}`} className="ma-row">
                <div className="ma-row-main">
                  <span className="ma-title">{item.title}</span>
                  <span className="ma-sub">Next{item.priority ? ` · ${item.priority}` : ''} · {item.age}</span>
                </div>
                {id && (
                  <button className="ma-chip" type="button" disabled={busy} onClick={() => void act(id, 'done')}>Done</button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {showTriage && !(triage?.now || []).length && !nextRows.length && (
        <p className="mini__empty">Nothing assigned. Linear is quiet.</p>
      )}
      {showTriage && triage && (
        <p className="ma-insight">
          {triage.later.count > 0
            ? `${triage.later.count} parked for later.`
            : 'Nothing parked for later.'}
        </p>
      )}
      {!showTriage && !connect && top && (
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
      {!showTriage && !connect && !issues.length && <p className="mini__empty">No issues assigned. Linear is quiet.</p>}
      {msg && <p className="mini__hint">{msg}</p>}
      {!showTriage && !connect && rest.length > 0 && (
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
  const rest = people.slice(1, 8)

  async function call(person: (typeof people)[number], hire: boolean) {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      if (!person.id.startsWith('n-')) {
        await apiPatchPipeline({ ...a, id: person.id, stage: hire ? 'won' : 'lost' })
      }
      await apiAddDecision({
        ...a,
        persona: auth.persona,
        decision: hire ? `Hire ${person.name}` : `Pass on ${person.name}`,
        reason: person.context || person.company || '',
      })
      setCalled(`${hire ? 'For' : 'Against'} ${person.name}`)
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
            <button className="ma-btn" type="button" disabled={busy} onClick={() => void call(next, true)}>For</button>
            <button className="ma-chip" type="button" disabled={busy} onClick={() => void call(next, false)}>Against</button>
          </div>
        </div>
      ) : (
        <p className="mini__empty">
          Text Alpha "we decided to pass on the VP" and it logs itself here. Or add a candidate on Pipeline (interview or offer); the call writes there and to Decisions.
        </p>
      )}
      {rest.length > 0 && (
        <ul className="ma-list">
          {rest.map((p) => (
            <li key={p.id} className="ma-row">
              <div className="ma-row-main">
                <span className="ma-title">{p.name}</span>
                <span className="ma-sub">{p.company || p.stage || p.context}</span>
              </div>
              <span className="ma-callout-actions">
                <button className="ma-chip" type="button" disabled={busy} onClick={() => void call(p, true)}>For</button>
                <button className="ma-chip" type="button" disabled={busy} onClick={() => void call(p, false)}>Against</button>
              </span>
            </li>
          ))}
        </ul>
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
  const [drafting, setDrafting] = useState(false)
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

  /* Ask Alpha to write the note from real data (pipeline, spend, decisions) and
   * park it as a pending investor draft. The route is new, so a 404 before it
   * ships just keeps the manual editor as the whole flow. */
  async function draftIt() {
    if (drafting) return
    setDrafting(true)
    setMsg('')
    try {
      const res = await apiDraftInvestorNote({ ...a, persona: auth.persona })
      const nextBody = res.draft?.body || res.investorDraft?.body || res.body
      const nextSubject = res.draft?.subject || res.investorDraft?.subject || res.subject
      const nextTo = res.draft?.toAddr
      if (nextTo && !to.trim()) setTo(nextTo)
      if (nextSubject) setSubject(nextSubject)
      if (nextBody) setBody(nextBody)
      load()
      if (!nextBody) setMsg('Alpha had nothing to draft yet. Write it below, or text "investor update" and it drafts itself.')
    } catch {
      setMsg('Drafting is not live yet. Write it below, or text "investor update" and it drafts itself.')
    } finally {
      setDrafting(false)
    }
  }

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
      {!sent && (
        <div className="ma-callout-actions">
          <button className="ma-btn" type="button" disabled={drafting || busy} onClick={() => void draftIt()}>
            {drafting ? 'Drafting' : 'Draft it'}
          </button>
          <span className="ma-sub">Alpha writes it from your real numbers. You edit before it sends.</span>
        </div>
      )}
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

/* ------------------------------- Standup -------------------------------- */

/** Clipboard write that survives in-app browsers: the async API first, and the
 * legacy execCommand path when the first is missing or refuses. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** The old build answers kind=standup_paste on /api/mini with a standup computed
 * from the calendar and GitHub. Until /api/standup/auto ships everywhere, that
 * answer is the graceful fallback rather than a dead screen. */
async function legacyStandup(persona: string, a: { email?: string; token?: string }) {
  try {
    const qs = new URLSearchParams({ persona })
    if (a.email) qs.set('email', a.email)
    else if (a.token) qs.set('t', a.token || '')
    const res = await fetch(`/api/mini?${qs}&kind=standup_paste`)
    if (!res.ok) return null
    const d = (await res.json()) as { sections?: Array<{ heading?: string; items?: string[] }> }
    const section = (d.sections || []).find((s) => s.heading === 'Paste this')
    return section?.items?.[0] || null
  } catch {
    return null
  }
}

export function StandupPasteApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [text, setText] = useState('')
  const [auto, setAuto] = useState(false)
  const [drafting, setDrafting] = useState(true)
  const [miss, setMiss] = useState(false)
  const [paste, setPaste] = useState('')
  const [copied, setCopied] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    setDrafting(true)
    setMsg('')
    apiStandupAuto({ ...a, persona: auth.persona })
      .then((d) => {
        if (d.text) {
          setText(d.text)
          setAuto(true)
          return null
        }
        return legacyStandup(auth.persona, a).then((t) => {
          if (t) {
            setText(t)
            setAuto(false)
          } else {
            setMiss(true)
          }
        })
      })
      .catch(() =>
        legacyStandup(auth.persona, a).then((t) => {
          if (t) {
            setText(t)
            setAuto(false)
          } else {
            setMiss(true)
          }
        }),
      )
      .finally(() => setDrafting(false))
  }, [a.email, a.token, auth.persona])
  useEffect(() => { load() }, [load])

  async function copy() {
    if (!text.trim()) return
    const ok = await copyText(text)
    setCopied(ok)
    if (ok) setTimeout(() => setCopied(false), 2000)
    else setMsg('Copy did not go through. Select the text and copy by hand.')
  }

  /* Pasting into the box is the override: what lands replaces the generated
   * standup outright, no second tap needed. */
  function pasteOverride(e: ClipboardEvent<HTMLTextAreaElement>) {
    const t = e.clipboardData.getData('text')
    if (!t.trim()) return
    e.preventDefault()
    setText(t.trim())
    setAuto(false)
    setPaste('')
    setCopied(false)
    setMsg('')
  }

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">
          {drafting ? 'Drafting' : auto ? 'Drafted from your day' : text ? 'Your notes' : 'Standup'}
        </span>
        <span className="ma-hero-num">{drafting ? 'Reading your day' : text ? 'Ready to paste' : 'Nothing yet'}</span>
        <span className="ma-hero-label">
          {drafting
            ? 'Alpha pulls meetings, promises, drafts, and decisions into three lines.'
            : auto
              ? 'Written from your day. Edit it, then copy.'
              : 'Paste your raw notes and they replace this.'}
        </span>
      </div>
      {miss && (
        <p className="mini__hint">Auto standup is not live yet. Paste your notes below to override.</p>
      )}
      <textarea
        className="ma-area"
        rows={8}
        value={text}
        onChange={(e) => { setText(e.target.value); setAuto(false); setCopied(false) }}
        placeholder={'Yesterday: ...\nToday: ...\nBlocked: ...'}
        aria-label="Standup text"
      />
      <div className="ma-callout-actions">
        <button className="ma-btn" type="button" disabled={!text.trim()} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        {miss && (
          <button className="ma-chip" type="button" disabled={drafting} onClick={() => void load()}>
            Retry
          </button>
        )}
      </div>
      <label className="ma-label">Paste your own instead
        <textarea
          className="ma-area"
          rows={3}
          value={paste}
          onPaste={pasteOverride}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="Raw notes. Pasting replaces the standup above."
          aria-label="Paste raw notes"
        />
      </label>
      {paste.trim() && (
        <button
          className="ma-chip"
          type="button"
          onClick={() => { setText(paste.trim()); setAuto(false); setPaste(''); setCopied(false) }}
        >
          Use mine
        </button>
      )}
      {msg && <p className="mini__hint">{msg}</p>}
    </div>
  )
}
