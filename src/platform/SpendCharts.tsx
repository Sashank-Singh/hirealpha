import {
  SPEND_SLOT_COLORS,
  spendCategorySlot,
  spendSegments,
  spendSlices,
  type SpendBarModel,
  type SpendInput,
} from './spendChart'

/**
 * The cap marker lives in CSS (`.spend-bar-cap`): a status colour marking a
 * threshold, never a category — which is why it also carries a worded label
 * underneath rather than standing alone.
 */
const dollars = (n: number) => `$${Math.round(n)}`

/** A category's colour, for legends the host renders in its own markup. */
export function SpendSwatch({ category }: { category: string }) {
  return (
    <span
      className="spend-swatch"
      aria-hidden="true"
      style={{ background: SPEND_SLOT_COLORS[spendCategorySlot(category)] }}
    />
  )
}

function barLabel(bar: SpendBarModel) {
  const parts = bar.segments.map((s) => `${s.label} ${dollars(s.amount)}`).join(', ')
  const cap = bar.budget ? ` of a ${dollars(bar.budget)} cap` : ''
  return `${dollars(bar.total)} spent${cap}. ${parts}`
}

/**
 * Week spend as one stacked bar: what it went on, and where it sits against the
 * cap. Hover gives a per-segment tooltip, but every number is also in the legend
 * text beside it, so nothing is only reachable by pointer.
 */
export function SpendBar({ rows, budget }: { rows: SpendInput[]; budget: number }) {
  const bar = spendSegments(rows, budget)
  if (!bar.segments.length && !bar.budget) return null

  let walked = 0
  return (
    <div className="spend-bar">
      <div className="spend-bar-track" role="img" aria-label={barLabel(bar)}>
        {bar.segments.map((s, i) => {
          const left = walked
          walked += s.pct
          const last = i === bar.segments.length - 1
          return (
            <div
              key={s.slot}
              className="spend-bar-seg"
              title={`${s.label}  ${dollars(s.amount)}  ${Math.round(s.share)}% of spend`}
              style={{
                left: `${left}%`,
                // The 2px gap is subtracted from the fill, so the separator is
                // surface showing through rather than a stroke over the data.
                width: last ? `${s.pct}%` : `calc(${s.pct}% - 2px)`,
                background: s.color,
                borderRadius: last ? '0 4px 4px 0' : undefined,
              }}
            />
          )
        })}
      </div>
      {/* Outside the track, which clips, so the marker can overhang the bar it crosses. */}
      {bar.capPct !== null && (
        <span className="spend-bar-cap" style={{ left: `${bar.capPct}%` }} aria-hidden="true" />
      )}
      <p className="spend-bar-foot">
        <span>{dollars(bar.total)} spent</span>
        {bar.budget ? (
          <span className={bar.over ? 'spend-bar-over' : undefined}>
            {bar.over
              ? `${dollars(bar.total - bar.budget)} over the ${dollars(bar.budget)} cap`
              : `${dollars(bar.budget - bar.total)} left of ${dollars(bar.budget)}`}
          </span>
        ) : null}
      </p>
    </div>
  )
}

/**
 * A donut over arbitrary named categories (inbox kinds, pipeline stages) rather
 * than the fixed spend slots. Colour follows position in a validated palette so
 * adjacent arcs stay separable; the value list beside it carries the real
 * comparison, same as SpendDonut.
 */
const DONUT_PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']

export type CategoryRow = { label: string; value: number }

export function CategoryDonut({
  rows,
  center,
  centerLabel,
  format = (n) => `${Math.round(n)}`,
}: {
  rows: CategoryRow[]
  center: string
  centerLabel: string
  format?: (n: number) => string
}) {
  const clean = (rows || []).filter((r) => r.value > 0)
  const total = clean.reduce((a, r) => a + r.value, 0)
  if (!clean.length || total <= 0) return null

  const radius = 36
  const gap = 2
  const circ = 2 * Math.PI * radius
  let walked = 0
  const slices = clean.map((r, i) => {
    const share = (r.value / total) * 100
    const span = (share / 100) * circ
    const drawn = clean.length > 1 ? Math.max(0, span - gap) : span
    const s = {
      ...r,
      share,
      color: DONUT_PALETTE[i % DONUT_PALETTE.length],
      dashArray: `${drawn} ${Math.max(0, circ - drawn)}`,
      dashOffset: walked > 0 ? -walked : 0,
    }
    walked += span
    return s
  })

  return (
    <div className="spend-donut">
      <div className="spend-donut-ring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <g transform="rotate(-90 50 50)">
            {slices.map((s) => (
              <circle
                key={s.label}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={s.color}
                strokeWidth="14"
                strokeDasharray={s.dashArray}
                strokeDashoffset={s.dashOffset}
              >
                <title>{`${s.label}  ${format(s.value)}  ${Math.round(s.share)}%`}</title>
              </circle>
            ))}
          </g>
        </svg>
        <div className="spend-donut-mid">
          <b>{center}</b>
          <span>{centerLabel}</span>
        </div>
      </div>
      <ul className="spend-donut-key">
        {slices.map((s) => (
          <li key={s.label}>
            <span className="spend-swatch" aria-hidden="true" style={{ background: s.color }} />
            <span className="spend-donut-key-name">{s.label}</span>
            <span className="spend-donut-key-val">{format(s.value)}</span>
            <span className="spend-donut-key-pct">{Math.round(s.share)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Part-to-whole at a glance, with the value list doing the real comparing — two
 * categories that landed within a few dollars of each other are indistinguishable
 * as arcs, so the list is the point rather than decoration.
 */
export function SpendDonut({ rows, centerLabel }: { rows: SpendInput[]; centerLabel?: string }) {
  const { slices, total, radius } = spendSlices(rows, { radius: 36 })
  if (!slices.length) return null

  return (
    <div className="spend-donut">
      <div className="spend-donut-ring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <g transform="rotate(-90 50 50)">
            {slices.map((s) => (
              <circle
                key={s.slot}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={s.color}
                strokeWidth="14"
                strokeDasharray={s.dashArray}
                strokeDashoffset={s.dashOffset}
              >
                <title>{`${s.label}  ${dollars(s.amount)}  ${Math.round(s.share)}%`}</title>
              </circle>
            ))}
          </g>
        </svg>
        <div className="spend-donut-mid">
          <b>{dollars(total)}</b>
          <span>{centerLabel || 'this week'}</span>
        </div>
      </div>
      <ul className="spend-donut-key">
        {slices.map((s) => (
          <li key={s.slot}>
            <SpendSwatch category={s.slot} />
            <span className="spend-donut-key-name">{s.label}</span>
            <span className="spend-donut-key-val">{dollars(s.amount)}</span>
            <span className="spend-donut-key-pct">{Math.round(s.share)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
