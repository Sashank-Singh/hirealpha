import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AGENTS, getAgent, type AgentId, type Msg } from '../../agents'
import { loadConnectedIds } from '../../data/connectors'
import { CONNECTORS } from '../../data/connectors'
import './agents.css'

const THREAD_KEY = 'hirealpha-threads-v2'

function seedThreads(): Record<AgentId, Msg[]> {
  return {
    friend: [...getAgent('friend').messages],
    coworker: [...getAgent('coworker').messages],
    cofounder: [...getAgent('cofounder').messages],
  }
}

function loadThreads(): Record<AgentId, Msg[]> {
  try {
    const raw = localStorage.getItem(THREAD_KEY)
    if (!raw) return seedThreads()
    return { ...seedThreads(), ...(JSON.parse(raw) as Record<AgentId, Msg[]>) }
  } catch {
    return seedThreads()
  }
}

function saveThreads(threads: Record<AgentId, Msg[]>) {
  localStorage.setItem(THREAD_KEY, JSON.stringify(threads))
}

export default function AgentsPage() {
  const [active, setActive] = useState<AgentId>('friend')
  const [threads, setThreads] = useState<Record<AgentId, Msg[]>>(loadThreads)
  const [draft, setDraft] = useState('')
  const [typing, setTyping] = useState(false)
  const [error, setError] = useState('')
  const [source, setSource] = useState<'model' | 'local' | null>(null)
  const [showSpec, setShowSpec] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)

  const agent = useMemo(() => getAgent(active), [active])
  const messages = threads[active] ?? []

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typing, active])

  function persist(next: Record<AgentId, Msg[]>) {
    setThreads(next)
    saveThreads(next)
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || typing) return

    const withMine: Record<AgentId, Msg[]> = {
      ...threads,
      [active]: [...messages, { text, from: 'me' }],
    }
    persist(withMine)
    setDraft('')
    setTyping(true)
    setError('')

    try {
      const connectedApps = loadConnectedIds()
        .map((id) => CONNECTORS.find((c) => c.id === id)?.name)
        .filter(Boolean) as string[]

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: active,
          messages: withMine[active],
          connectedApps,
        }),
      })
      const data = (await res.json()) as {
        reply?: string
        source?: 'model' | 'local'
        error?: string
      }
      if (!res.ok) throw new Error(data.error || 'Chat failed')

      setSource(data.source ?? 'local')
      persist({
        ...withMine,
        [active]: [...withMine[active], { text: data.reply || '…', from: 'them' }],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat failed')
      // keep the user message; they can retry
    } finally {
      setTyping(false)
    }
  }

  return (
    <div className={`agents${showSpec ? ' agents--spec' : ''}`}>
      <aside className="agents__list">
        <header>
          <h1>Agents</h1>
          <p>Three numbers. Three prompts.</p>
        </header>
        {AGENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`agents__row${active === a.id ? ' agents__row--active' : ''}`}
            onClick={() => setActive(a.id)}
          >
            <span className="agents__avatar" style={{ background: a.color }}>
              {a.initial}
            </span>
            <span className="agents__meta">
              <strong>{a.imsgName}</strong>
              <small>{a.phoneDisplay}</small>
            </span>
          </button>
        ))}
      </aside>

      <section className="agents__chat">
        <header className="agents__chat-head">
          <div className="agents__avatar" style={{ background: agent.color }}>
            {agent.initial}
          </div>
          <div>
            <h2>{agent.imsgName}</h2>
            <p>
              {agent.role} · {agent.phoneDisplay}
              {source ? ` · ${source === 'model' ? 'live model' : 'local runtime'}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="agents__spec-toggle"
            onClick={() => setShowSpec((v) => !v)}
          >
            {showSpec ? 'Hide spec' : 'Show spec'}
          </button>
        </header>

        <div className="agents__thread">
          {messages.map((m, i) => (
            <div key={`${active}-${i}`} className={`agents__bubble agents__bubble--${m.from}`}>
              {m.text}
            </div>
          ))}
          {typing && (
            <div className="agents__bubble agents__bubble--them agents__bubble--typing">
              <span /><span /><span />
            </div>
          )}
          {error && <p className="agents__error">{error}</p>}
          <div ref={endRef} />
        </div>

        <form className="agents__composer" onSubmit={send}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Text ${agent.imsgName}`}
            aria-label={`Text ${agent.imsgName}`}
          />
          <button type="submit" className="btn btn--primary" disabled={!draft.trim() || typing}>
            Send
          </button>
        </form>
      </section>

      {showSpec && (
        <aside className="agents__spec">
          <h3>Agent spec</h3>
          <dl>
            <div>
              <dt>Messages name</dt>
              <dd>{agent.imsgName}</dd>
            </div>
            <div>
              <dt>Number</dt>
              <dd>
                <code>{agent.phoneNumber}</code>
                <span>{agent.phoneDisplay}</span>
              </dd>
            </div>
            <div>
              <dt>Tone</dt>
              <dd>{agent.behavior.tone}</dd>
            </div>
            <div>
              <dt>Reply style</dt>
              <dd>{agent.behavior.replyStyle}</dd>
            </div>
          </dl>

          <h4>Does</h4>
          <ul>
            {agent.behavior.does.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>

          <h4>Never</h4>
          <ul>
            {agent.behavior.never.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>

          <h4>Rules</h4>
          <ul>
            {agent.behavior.rules.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>

          <h4>System prompt</h4>
          <pre className="agents__prompt">{agent.systemPrompt}</pre>
        </aside>
      )}
    </div>
  )
}
