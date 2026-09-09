import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  apiDeleteSpend,
  apiListSpending,
  apiLogSpend,
  apiSetSpendBudget,
  type SpendLog,
} from './api'
import type { FeatureAuth } from './FeatureMiniApps'
import { useStableAuth } from './useStableAuth'
import { useRefreshOnFocus } from './useRefreshOnFocus'
import { SpendDonut, SpendSwatch } from './SpendCharts'
import { SPEND_SLOTS, SPEND_SLOT_LABELS } from './spendChart'
import { readSpendSeed, writeSpendCache } from './spendCache'

function daysLeftInWeek(weekStart: string) {
  if (!weekStart) return 0
  const [y, m, d] = weekStart.split('-').map(Number)
  const end = new Date(y || 1970, (m || 1) - 1, (d || 1) + 6)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((end.getTime() - today.getTime()) / 86400000))
}

export function SpendingSnapshotApp({ auth }: { auth: FeatureAuth }) {
  const a = useStableAuth(auth)
  const seed = readSpendSeed(a)

  const [logs, setLogs] = useState<SpendLog[]>(seed.logs)
  const [byCategory, setByCategory] = useState<Array<{ category: string; total: number }>>(seed.byCategory)
  const [weekTotal, setWeekTotal] = useState(seed.weekTotal)
  const [budget, setBudget] = useState(seed.weeklyBudget)
  const [weekStart, setWeekStart] = useState(seed.weekStart)
  const [budgetEdit, setBudgetEdit] = useState('')
  const [showBudget, setShowBudget] = useState(false)
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('food')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showLog, setShowLog] = useState(false)

  const load = useCallback(() => {
    apiListSpending(a)
      .then((d) => {
        setLogs(d.logs || [])
        setByCategory(d.byCategory || [])
        setWeekTotal(d.weekTotal || 0)
        setBudget(d.weeklyBudget || 400)
        setWeekStart(d.weekStart || '')
        if (d.logs?.[0]?.category) setCategory(d.logs[0].category)
        writeSpendCache(a, {
          logs: d.logs || [],
          byCategory: d.byCategory || [],
          weekTotal: d.weekTotal || 0,
          weeklyBudget: d.weeklyBudget || 400,
          weekStart: d.weekStart || '',
        })
      })
      .catch(() => {
        // If network fails but we had cached data, don't scream error unless empty
        if (!weekTotal && !logs.length) {
          setMsg('Could not load spending.')
        }
      })
  }, [a, weekTotal, logs.length])

  useEffect(() => {
    load()
  }, [load])
  useRefreshOnFocus(load)

  async function add(e: FormEvent) {
    e.preventDefault()
    const n = Number(amount)
    if (!n || n <= 0 || busy) return
    setBusy(true)

    // Optimistic update for instant feel
    const prevTotal = weekTotal
    const prevByCat = [...byCategory]
    const nextTotal = weekTotal + n
    const existingCat = prevByCat.find((c) => c.category === category)
    const nextByCat = existingCat
      ? prevByCat.map((c) => (c.category === category ? { ...c, total: c.total + n } : c))
      : [...prevByCat, { category, total: n }]

    setWeekTotal(nextTotal)
    setByCategory(nextByCat)
    setAmount('')
    setShowLog(false)

    // Sync to cache immediately so navigating back to Home is instantaneous
    writeSpendCache(a, {
      logs,
      byCategory: nextByCat,
      weekTotal: nextTotal,
      weeklyBudget: budget,
      weekStart,
    })

    try {
      await apiLogSpend({ ...a, amount: n, category })
      load()
    } catch {
      // Revert if server rejected
      setWeekTotal(prevTotal)
      setByCategory(prevByCat)
      setMsg('Could not log that.')
    } finally {
      setBusy(false)
    }
  }

  const left = budget - weekTotal
  const over = left < 0
  const remainDays = Math.max(1, daysLeftInWeek(weekStart) + 1)
  const perDay = !over ? Math.round(Math.max(0, left) / remainDays) : 0
  const last = logs[0]
  const topCat = [...byCategory].sort((x, y) => y.total - x.total)[0]
  const chartRows = byCategory.map((c) => ({ category: c.category, amount: c.total }))

  return (
    <div className="ma">
      <div className={`spend-hero${over ? ' spend-hero--over' : ''}`}>
        <div className="ma-hero">
          <span className="ma-hero-kicker">{over ? 'Over budget' : 'This week'}</span>
          <div className="spend-total">
            {over ? `$${Math.round(-left)} over` : `$${Math.round(Math.max(0, left))} left`}
            <span> / ${Math.round(budget)}</span>
          </div>
          <p className="ma-insight">
            {over
              ? `${topCat ? topCat.category : 'Spending'} is the leak.`
              : weekTotal > 0 || logs.length
                ? `$${perDay} a day left${topCat ? `. Most on ${topCat.category}` : ''}`
                : 'Log the next spend. The week total fills in.'}
          </p>
        </div>
        <button
          className="ma-chip"
          type="button"
          onClick={() => {
            setBudgetEdit(String(budget))
            setShowBudget((v) => !v)
          }}
        >
          Budget
        </button>
      </div>

      {showBudget && (
        <form
          className="ma-form"
          onSubmit={(e) => {
            e.preventDefault()
            const next = Number(budgetEdit)
            if (next > 0) {
              setBudget(next)
              writeSpendCache(a, {
                logs,
                byCategory,
                weekTotal,
                weeklyBudget: next,
                weekStart,
              })
              void apiSetSpendBudget({ ...a, weeklyBudget: next }).then(() => {
                setShowBudget(false)
                load()
              })
            }
          }}
        >
          <input
            className="ma-input ma-input--sm"
            value={budgetEdit}
            onChange={(e) => setBudgetEdit(e.target.value)}
            inputMode="decimal"
            aria-label="Weekly budget"
          />
          <button className="ma-btn" type="submit">
            Save budget
          </button>
        </form>
      )}

      <SpendDonut rows={chartRows} />

      <div className="ma-pills">
        {SPEND_SLOTS.map((c) => {
          const row = byCategory.find((x) => x.category === c)
          return (
            <button
              key={c}
              type="button"
              className={`ma-chip${category === c ? ' ma-chip--on' : ''}`}
              onClick={() => {
                setCategory(c)
                setShowLog(true)
              }}
            >
              <SpendSwatch category={c} />
              {SPEND_SLOT_LABELS[c]}
              {row ? ` $${Math.round(row.total)}` : ''}
            </button>
          )
        })}
      </div>

      {showLog || logs.length === 0 ? (
        <form className="ma-form" onSubmit={add}>
          <input
            className="ma-input ma-input--sm"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="$"
            aria-label="Amount"
            autoFocus
          />
          <button className="ma-btn" type="submit" disabled={busy || !amount}>
            Log {category}
          </button>
        </form>
      ) : (
        <button className="ma-btn ma-btn--block" type="button" onClick={() => setShowLog(true)}>
          {last ? `Log ${last.category}` : 'Log spend'}
        </button>
      )}

      {msg && <p className="mini__hint">{msg}</p>}

      {logs.length > 0 && (
        <div className="spend-history" style={{ marginTop: 24 }}>
          <h3 className="hA-section-title" style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, opacity: 0.7 }}>
            Recent Activity
          </h3>
          <ul className="mini__list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {logs.slice(0, 15).map((log) => (
              <li
                key={log.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 14px',
                  borderRadius: 12,
                  background: 'var(--card-bg, rgba(255,255,255,0.03))',
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <SpendSwatch category={log.category} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, textTransform: 'capitalize' }}>
                      {log.description || log.category}
                    </div>
                    {log.description && (
                      <div style={{ fontSize: 11, color: 'var(--muted-fg)', textTransform: 'capitalize' }}>
                        {log.category}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    ${Math.round(log.amount)}
                  </span>
                  <button
                    type="button"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--muted-fg)',
                      cursor: 'pointer',
                      padding: 4,
                      fontSize: 16,
                      lineHeight: 1,
                      opacity: 0.5,
                    }}
                    title="Delete entry"
                    onClick={async () => {
                      try {
                        await apiDeleteSpend({ ...a, id: log.id })
                        load()
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
