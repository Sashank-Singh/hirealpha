import { useMemo } from 'react'
import type { NetworkPerson } from './api'

/* The People mini-app as a knowledge graph: one node per contact, placed on a
 * golden-angle spiral around "you", colored by where you met them, and linked
 * both to you and to people from the same place — a network, not a list. */

const GOLDEN = 2.399963229728653
const CX = 170
const CY = 125
const MAX_NODES = 28
const CLUSTERS = ['#34d0b6', '#5aa9ff', '#f6b26b', '#7b6ff0', '#ff8fa3', '#a7d263']

function daysSince(d: string | null): number {
  if (!d) return 999
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000)
}

function firstName(name: string): string {
  return String(name || '').trim().split(/\s+/)[0] || name || ''
}

export function PeopleGraph({
  people,
  selectedId,
  onSelect,
}: {
  people: NetworkPerson[]
  selectedId?: string | null
  onSelect: (p: NetworkPerson) => void
}) {
  const nodes = useMemo(() => {
    const clusterMap = new Map<string, string>()
    const ranked = [...people].sort((a, b) => {
      const ao = daysSince(a.lastTouch) - a.cadenceDays
      const bo = daysSince(b.lastTouch) - b.cadenceDays
      return bo - ao
    })
    const max = Math.min(MAX_NODES, ranked.length)
    return ranked.slice(0, max).map((p, i) => {
      const rad = 40 + 68 * Math.sqrt((i + 0.5) / Math.max(10, max))
      const ang = i * GOLDEN
      const key = ((p.whereMet || p.company || '').trim().toLowerCase() || '—')
      if (!clusterMap.has(key)) clusterMap.set(key, CLUSTERS[clusterMap.size % CLUSTERS.length])
      const due = daysSince(p.lastTouch) >= p.cadenceDays
      return {
        p,
        x: CX + rad * Math.cos(ang),
        y: CY + rad * Math.sin(ang),
        r: due ? 13 : 9.5,
        color: clusterMap.get(key)!,
        due,
        label: i < 5 || selectedId === p.id ? firstName(p.name) : '',
      }
    })
  }, [people, selectedId])

  const clusterEdges = useMemo(() => {
    const byCluster = new Map<string, number[]>()
    nodes.forEach((n, i) => {
      const k = ((n.p.whereMet || n.p.company || '').trim().toLowerCase() || '—')
      const arr = byCluster.get(k) ?? []
      arr.push(i)
      byCluster.set(k, arr)
    })
    const out: Array<[number, number]> = []
    for (const arr of byCluster.values()) {
      for (let i = 0; i + 1 < arr.length; i++) out.push([arr[i], arr[i + 1]])
    }
    return out
  }, [nodes])

  return (
    <svg
      viewBox="0 0 340 250"
      className="people-graph"
      role="img"
      aria-label="Your people network. Tap a node to open that person."
    >
      {/* connections from you */}
      {nodes.map((n, i) => (
        <line key={`e${i}`} className="pg-edge" x1={CX} y1={CY} x2={n.x} y2={n.y} stroke={n.color} />
      ))}
      {/* connections between people who met in the same place */}
      {clusterEdges.map(([a, b], i) => (
        <line
          key={`c${i}`}
          className="pg-edge pg-edge--cluster"
          x1={nodes[a].x}
          y1={nodes[a].y}
          x2={nodes[b].x}
          y2={nodes[b].y}
          stroke={nodes[a].color}
        />
      ))}

      {/* you, at the center */}
      <circle className="pg-pulse" cx={CX} cy={CY} r={24} />
      <g className="pg-you">
        <circle className="pg-you-core" cx={CX} cy={CY} r={17} />
        <text className="pg-you-label" x={CX} y={CY + 5} textAnchor="middle">
          You
        </text>
      </g>

      {/* the people */}
      {nodes.map((n, i) => (
        <g key={n.p.id} transform={`translate(${n.x} ${n.y})`}>
          <g
            className={`pg-node${n.due ? ' pg-node--due' : ''}${selectedId === n.p.id ? ' pg-node--sel' : ''}`}
            style={{ '--i': i } as React.CSSProperties}
          >
            {n.due && <circle className="pg-node-pulse" r={n.r + 6} stroke={n.color} />}
            <circle
              className="pg-node-core"
              r={n.r}
              fill={n.color}
              role="button"
              tabIndex={0}
              aria-label={`${n.p.name}${n.due ? ' — due a follow-up' : ''}`}
              onClick={() => onSelect(n.p)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  onSelect(n.p)
                }
              }}
            />
            {n.label && (
              <text className="pg-label" y={n.r + 14} textAnchor="middle">
                {n.label}
              </text>
            )}
          </g>
        </g>
      ))}
    </svg>
  )
}
