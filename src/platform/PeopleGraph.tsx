import { useEffect, useMemo, useRef, useState } from 'react'
import type { NetworkPerson } from './api'

/* The People mini-app as a living 3D neural network whose geometry carries data:
 * - Distance from "you" = relationship temperature (daysSince/cadence): fresh
 *   ties orbit tight and bright, neglected ones drift out toward the rim.
 * - Edge brightness/width = recency; synaptic pulses only ride live edges;
 *   due-for-a-touch edges glow warm as a warning.
 * - Small same-place communities are fully-connected cliques (big ones chain).
 * - Angular direction = community (where you met). Color matches the legend.
 * Drag to spin, tap a node to focus it and see its stats inline. */

const GOLDEN = 2.399963229728653
const MAX_NODES = 28
const CLUSTERS = ['#34d0b6', '#5aa9ff', '#f6b26b', '#7b6ff0', '#ff8fa3', '#a7d263']
const FOV = 3.6
const WARM = '#ff9066'

function daysSince(d: string | null): number {
  if (!d) return 999
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000)
}

function firstName(name: string): string {
  return String(name || '').trim().split(/\s+/)[0] || name || ''
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let v = m[1]
  if (v.length === 3) v = v.split('').map((c) => c + c).join('')
  const n = parseInt(v, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgba(hex: string, a: number, fallback: string): string {
  const rgb = hexRgb(hex)
  if (!rgb) return fallback
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
/* 1 when the point is close to the camera, 0 when far behind the scene */
const depthA = (z: number, range: number) => clamp01((range - z) / (2 * range))

type Vec3 = [number, number, number]

type Node3 = {
  p: NetworkPerson
  pos: Vec3
  r: number
  color: string
  due: boolean
  fresh: number /* 1 just-touched .. 0 long-neglected */
  label: string
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
  const [focusId, setFocusId] = useState<string | null>(null)

  const { nodes, cliqueEdges, legend } = useMemo(() => {
    const keyOf = (p: NetworkPerson) =>
      ((p.whereMet || p.company || '').trim().toLowerCase() || '—')
    const ranked = [...people].sort((a, b) => {
      const ao = daysSince(a.lastTouch) - a.cadenceDays
      const bo = daysSince(b.lastTouch) - b.cadenceDays
      return bo - ao
    })
    const picked = ranked.slice(0, Math.min(MAX_NODES, ranked.length))

    const keys: string[] = []
    picked.forEach((p) => {
      const k = keyOf(p)
      if (!keys.includes(k)) keys.push(k)
    })
    /* one anchor direction per community, spread on a fibonacci sphere */
    const dirs: Vec3[] = keys.map((_, c) => {
      const y = 1 - (2 * (c + 0.5)) / Math.max(1, keys.length)
      const rad = Math.sqrt(Math.max(0, 1 - y * y))
      const th = c * GOLDEN
      return [rad * Math.cos(th), y * 0.9, rad * Math.sin(th)]
    })

    const nodes: Node3[] = picked.map((p, i) => {
      const rnd = mulberry32(i * 7919 + 13)
      const c = keys.indexOf(keyOf(p))
      const dir = dirs[c]
      /* temperature drives the radius: due-by-2x-cadence sits at the rim */
      const raw = p.lastTouch ? daysSince(p.lastTouch) / Math.max(1, p.cadenceDays) : 3
      const tRad = clamp01(raw / 2)
      const radius = 0.42 + tRad * 1.08
      /* small tangential jitter so each community reads as one knot */
      const u = rnd() * 2 - 1
      const th = rnd() * Math.PI * 2
      const s = Math.sqrt(Math.max(0, 1 - u * u))
      const spread = keys.length > 1 ? 0.17 : 0.4
      const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1
      const ux = dir[0] / dl
      const uy = dir[1] / dl
      const uz = dir[2] / dl
      /* two vectors orthogonal to the community direction */
      let ax = uy * 0 - uz * 1
      let ay = uz * 0 - ux * 0
      let az = ux * 1 - uy * 0
      if (Math.abs(az) < 0.01) { ax = 1; ay = 0; az = 0 }
      const al = Math.hypot(ax, ay, az) || 1
      ax /= al; ay /= al; az /= al
      const bx = uy * az - uz * ay
      const by = uz * ax - ux * az
      const bz = ux * ay - uy * ax
      const bl = Math.hypot(bx, by, bz) || 1
      const ca = s * Math.cos(th) * spread / al
      const sb = s * Math.sin(th) * spread / bl
      const due = daysSince(p.lastTouch) >= p.cadenceDays
      return {
        p,
        pos: [
          ux * radius + (ax * ca + bx * sb),
          uy * radius + (ay * ca + by * sb),
          uz * radius + (az * ca + bz * sb),
        ],
        r: due ? 7.5 : 5.5,
        color: CLUSTERS[c % CLUSTERS.length],
        due,
        fresh: clamp01(1 - raw / 1.15),
        label: i < 5 ? firstName(p.name) : '',
      }
    })

    /* cliques: small communities fully connect, big ones chain */
    const byCluster = new Map<string, number[]>()
    nodes.forEach((n, i) => {
      const k = keyOf(n.p)
      const arr = byCluster.get(k) ?? []
      arr.push(i)
      byCluster.set(k, arr)
    })
    const cliqueEdges: Array<[number, number]> = []
    for (const arr of byCluster.values()) {
      if (arr.length <= 6) {
        for (let i = 0; i < arr.length; i++)
          for (let j = i + 1; j < arr.length; j++) cliqueEdges.push([arr[i], arr[j]])
      } else {
        for (let i = 0; i + 1 < arr.length; i++) cliqueEdges.push([arr[i], arr[i + 1]])
      }
    }

    const legend = keys.map((k, c) => ({
      key: k,
      label: k === '—' ? 'Elsewhere' : k,
      color: CLUSTERS[c % CLUSTERS.length],
    }))
    return { nodes, cliqueEdges, legend }
  }, [people])

  const focusIdx = nodes.findIndex((n) => n.p.id === (focusId ?? selectedId))
  const focusPerson = focusIdx >= 0 ? nodes[focusIdx].p : null

  /* decorative synapse mesh floating behind the real network */
  const ambient = useMemo(() => {
    const rnd = mulberry32(42)
    const N = 90
    const pts: Vec3[] = []
    for (let i = 0; i < N; i++) {
      const u = rnd() * 2 - 1
      const th = rnd() * Math.PI * 2
      const s = Math.sqrt(Math.max(0, 1 - u * u))
      const rad = 1.7 + rnd() * 0.9
      pts.push([s * Math.cos(th) * rad, u * rad, s * Math.sin(th) * rad])
    }
    const seen = new Set<string>()
    const links: Array<[number, number]> = []
    for (let i = 0; i < N; i++) {
      let bj = -1
      let bd = Infinity
      for (let j = 0; j < N; j++) {
        if (j === i) continue
        const dx = pts[i][0] - pts[j][0]
        const dy = pts[i][1] - pts[j][1]
        const dz = pts[i][2] - pts[j][2]
        const d = dx * dx + dy * dy + dz * dz
        if (d < bd) {
          bd = d
          bj = j
        }
      }
      const key = i < bj ? `${i}-${bj}` : `${bj}-${i}`
      if (bj >= 0 && !seen.has(key) && rnd() < 0.8) {
        seen.add(key)
        links.push([i, bj])
      }
    }
    return { pts, links }
  }, [])

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(cliqueEdges)
  edgesRef.current = cliqueEdges
  const focusRef = useRef(focusIdx)
  focusRef.current = focusIdx
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const css = getComputedStyle(canvas)
    const accent = (css.getPropertyValue('--mini-accent').trim() || '#2a6f7a')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

    let W = 0
    let H = 0
    let dpr = 1
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      W = canvas.clientWidth
      H = canvas.clientHeight
      canvas.width = Math.max(1, Math.round(W * dpr))
      canvas.height = Math.max(1, Math.round(H * dpr))
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const view = { ry: 0.7, rx: 0.34, vry: 0, dragging: false, lx: 0, ly: 0, moved: 0 }
    let hits: Array<{ p: NetworkPerson; x: number; y: number; r: number; z: number }> = []

    const pick = (x: number, y: number) => {
      let best: (typeof hits)[number] | null = null
      for (const h of hits) {
        const d = Math.hypot(x - h.x, y - h.y)
        if (d <= h.r && (!best || h.z < best.z)) best = h
      }
      return best
    }

    let raf = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const t = now / 1000
      const still = reduced.matches
      if (!view.dragging) {
        view.ry += view.vry
        view.vry *= 0.94
        if (!still && Math.abs(view.vry) < 0.0008) view.ry += 0.0016
      }
      const rx = view.rx + (still ? 0 : Math.sin(t * 0.21) * 0.05)
      const cosY = Math.cos(view.ry)
      const sinY = Math.sin(view.ry)
      const cosX = Math.cos(rx)
      const sinX = Math.sin(rx)
      const cx = W / 2
      const cy = H / 2
      const S = Math.min(W, H) * 0.36
      const proj = (p: Vec3) => {
        const X = p[0] * cosY + p[2] * sinY
        let Z = -p[0] * sinY + p[2] * cosY
        const Y = p[1] * cosX - Z * sinX
        Z = p[1] * sinX + Z * cosX
        const k = FOV / (FOV + Z)
        return { x: cx + X * S * k, y: cy + Y * S * k, k, z: Z }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      /* ambient synapse mesh */
      const ap = ambient.pts.map(proj)
      ctx.lineWidth = 0.6
      for (const [a, b] of ambient.links) {
        const pa = ap[a]
        const pb = ap[b]
        const a0 = 0.1 * Math.min(depthA(pa.z, 2.6), depthA(pb.z, 2.6))
        if (a0 <= 0.01) continue
        ctx.strokeStyle = `rgba(148,180,200,${a0})`
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pb.x, pb.y)
        ctx.stroke()
      }
      ap.forEach((p, i) => {
        const d = depthA(p.z, 2.6)
        ctx.fillStyle = i % 7 === 0 ? rgba(accent, 0.16 + 0.3 * d, accent) : `rgba(148,180,200,${0.08 + 0.22 * d})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, (i % 7 === 0 ? 1.5 : 0.9) * p.k, 0, Math.PI * 2)
        ctx.fill()
      })

      const list = nodesRef.current
      const you = proj([0, 0, 0])
      const focus = focusRef.current
      /* when focused, everything that isn't the focus dims */
      const dimOf = (i: number) => (focus >= 0 && i !== focus ? 0.28 : 1)

      const pp = list.map((n) => proj(n.pos))

      /* edges: you -> person, brightness/width carry recency; due edges glow warm */
      list.forEach((n, i) => {
        const d = depthA(pp[i].z, 1.6)
        const dim = dimOf(i)
        const col = n.due ? WARM : n.color
        ctx.strokeStyle = rgba(col, (0.07 + 0.5 * n.fresh) * d * dim, col)
        ctx.lineWidth = (0.7 + 1.8 * n.fresh + (n.due ? 0.6 : 0)) * pp[i].k
        ctx.beginPath()
        ctx.moveTo(you.x, you.y)
        ctx.lineTo(pp[i].x, pp[i].y)
        ctx.stroke()
      })
      for (const [a, b] of edgesRef.current) {
        const dim = Math.min(dimOf(a), dimOf(b))
        if (dim < 1) continue
        const d = Math.min(depthA(pp[a].z, 1.6), depthA(pp[b].z, 1.6))
        ctx.strokeStyle = rgba(list[a].color, 0.08 + 0.24 * d, list[a].color)
        ctx.lineWidth = 0.8
        ctx.beginPath()
        ctx.moveTo(pp[a].x, pp[a].y)
        ctx.lineTo(pp[b].x, pp[b].y)
        ctx.stroke()
      }

      /* synaptic pulses ride only live (not-yet-due) edges; faster when fresher */
      if (!still) {
        list.forEach((n, i) => {
          if (n.due || n.fresh < 0.06) return
          const speed = 0.09 + 0.14 * n.fresh
          const phase = (t * speed + i * 0.37) % 1
          const p3: Vec3 = [n.pos[0] * phase, n.pos[1] * phase, n.pos[2] * phase]
          const q = proj(p3)
          const d = depthA(q.z, 1.6)
          ctx.save()
          ctx.shadowColor = rgba(n.color, 0.9, n.color)
          ctx.shadowBlur = 7
          ctx.fillStyle = rgba(n.color, (0.25 + 0.65 * d) * dimOf(i), n.color)
          ctx.beginPath()
          ctx.arc(q.x, q.y, 1.7 * q.k, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        })
      }

      /* nodes, far to near */
      const order = list.map((_, i) => i).sort((a, b) => pp[b].z - pp[a].z)
      const nextHits: typeof hits = []
      for (const i of order) {
        const n = list[i]
        const q = pp[i]
        const d = depthA(q.z, 1.6)
        const dim = dimOf(i)
        const r = n.r * q.k
        const sel = focusRef.current === i
        ctx.save()
        ctx.shadowColor = rgba(n.color, (0.35 + 0.55 * d) * dim, n.color)
        ctx.shadowBlur = (sel ? 16 : 10) * q.k
        ctx.fillStyle = rgba(n.color, (0.45 + 0.55 * d) * dim, n.color)
        ctx.beginPath()
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
        if (n.due && !still) {
          const pr = (t / 2.2 + i * 0.13) % 1
          ctx.strokeStyle = rgba(WARM, ((1 - pr) * 0.55 * d + 0.08) * dim, WARM)
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.arc(q.x, q.y, r + 2 + pr * 7, 0, Math.PI * 2)
          ctx.stroke()
        }
        if (sel) {
          ctx.strokeStyle = 'rgba(255,255,255,0.9)'
          ctx.lineWidth = 1.8
          ctx.beginPath()
          ctx.arc(q.x, q.y, r + 2.5, 0, Math.PI * 2)
          ctx.stroke()
        }
        if (n.label || sel) {
          ctx.fillStyle = `rgba(214,226,235,${(0.35 + 0.6 * d) * dim})`
          ctx.font = '600 10px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(sel && !n.label ? firstName(n.p.name) : n.label, q.x, q.y + r + 13)
        }
        nextHits.push({ p: n.p, x: q.x, y: q.y, r: Math.max(r, 7) + 7, z: q.z })
      }

      /* you, glowing at the core */
      ctx.save()
      ctx.shadowColor = rgba(accent, 0.9, accent)
      ctx.shadowBlur = 22
      ctx.fillStyle = rgba(accent, 1, accent)
      ctx.beginPath()
      ctx.arc(you.x, you.y, 11 * you.k, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.arc(you.x, you.y, 11 * you.k, 0, Math.PI * 2)
      ctx.stroke()
      if (!still) {
        const pr = (t / 2.8) % 1
        ctx.strokeStyle = rgba(accent, (1 - pr) * 0.5, accent)
        ctx.lineWidth = 1.4
        ctx.beginPath()
        ctx.arc(you.x, you.y, (13 + pr * 24) * you.k, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(4,26,22,0.95)'
      ctx.font = '800 10px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('You', you.x, you.y + 3.5)

      hits = nextHits
    }
    raf = requestAnimationFrame(draw)

    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      view.dragging = true
      view.moved = 0
      view.lx = e.clientX
      view.ly = e.clientY
      view.vry = 0
      canvas.style.cursor = 'grabbing'
    }
    const move = (e: PointerEvent) => {
      if (!view.dragging) {
        const rect = canvas.getBoundingClientRect()
        canvas.style.cursor = pick(e.clientX - rect.left, e.clientY - rect.top) ? 'pointer' : 'grab'
        return
      }
      const dx = e.clientX - view.lx
      const dy = e.clientY - view.ly
      view.lx = e.clientX
      view.ly = e.clientY
      view.moved += Math.abs(dx) + Math.abs(dy)
      if (view.moved > 4) {
        view.ry += dx * 0.0052
        view.rx = Math.max(-1.2, Math.min(1.2, view.rx + dy * 0.0038))
        view.vry = dx * 0.0026
      }
    }
    const up = (e: PointerEvent) => {
      const wasDrag = view.moved > 6
      view.dragging = false
      canvas.style.cursor = 'grab'
      if (!wasDrag) {
        const rect = canvas.getBoundingClientRect()
        const hit = pick(e.clientX - rect.left, e.clientY - rect.top)
        if (hit) {
          setFocusId((cur) => (cur === hit.p.id ? null : hit.p.id))
          onSelectRef.current(hit.p)
        } else {
          setFocusId(null)
        }
      }
    }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
    }
  }, [ambient])

  return (
    <div className="people-graph-wrap">
      <canvas
        ref={canvasRef}
        className="people-graph"
        role="img"
        aria-label="Your people network as a spinning 3D graph. Nodes closer to the center are fresher connections. Drag to spin it; tap a node to focus that person."
      />
      {legend.length > 1 && (
        <div className="pg-legend" aria-hidden="true">
          {legend.map((l) => (
            <span key={l.key} className="pg-legend-chip">
              <i style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      {focusPerson && (
        <div className="pg-card">
          <button
            type="button"
            className="pg-card-close"
            aria-label="Close"
            onClick={() => setFocusId(null)}
          >
            ×
          </button>
          <strong>{focusPerson.name}</strong>
          <span className="pg-card-sub">
            {[focusPerson.whereMet, focusPerson.company].filter(Boolean).join(' · ') || 'Met somewhere'}
          </span>
          <span className={`pg-card-stat${daysSince(focusPerson.lastTouch) >= focusPerson.cadenceDays ? ' pg-card-stat--due' : ''}`}>
            {focusPerson.lastTouch
              ? `${daysSince(focusPerson.lastTouch)}d since last touch · every ${focusPerson.cadenceDays}d`
              : 'Never logged a touch'}
          </span>
          <button type="button" className="ma-chip" onClick={() => onSelect(focusPerson)}>
            Open
          </button>
        </div>
      )}
      <div className="pg-sr">
        {nodes.map((n) => (
          <button key={n.p.id} type="button" tabIndex={0} onClick={() => onSelect(n.p)}>
            {n.p.name}
            {n.due ? ' — due a follow-up' : ''}
          </button>
        ))}
      </div>
    </div>
  )
}
