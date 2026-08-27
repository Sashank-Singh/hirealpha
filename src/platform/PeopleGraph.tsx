import { useEffect, useMemo, useRef, useState } from 'react'
import type { NetworkPerson } from './api'
import { cadenceLabel } from './peopleMeets'

/* The People mini-app as a quiet 3D instrument whose geometry carries data:
 * - Distance from "you" = relationship temperature (daysSince/cadence): fresh
 *   ties orbit tight, neglected ones drift out toward the rim.
 * - Edge brightness/width = recency; due-for-a-touch edges carry a warm tint.
 * - Small same-place communities are fully-connected cliques (big ones chain).
 * - Angular direction = community (where you met). Color matches the legend.
 * No glows, no particles, no pulses — the data is the decoration.
 * Drag to spin, tap a node to focus it and see its stats inline. */

const GOLDEN = 2.399963229728653
const MAX_NODES = 28
const CLUSTERS = ['#5fb8a8', '#7f9fc4', '#c2a36b', '#a08cb8', '#c47a7a', '#7fb098']
const FOV = 3.6
const WARM = '#d08662'

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
  /* Null clears the selection — the X worked only locally before, and the
   * parent's selectedId kept the card open. */
  onSelect: (p: NetworkPerson | null) => void
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
      const radius = 0.45 + tRad * 0.65
      /* small tangential jitter so each community reads as one knot */
      const u = rnd() * 2 - 1
      const th = rnd() * Math.PI * 2
      const s = Math.sqrt(Math.max(0, 1 - u * u))
      const spread = keys.length > 1 ? 0.17 : 0.4
      const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1
      const ux = dir[0] / dl
      const uy = dir[1] / dl
      const uz = dir[2] / dl
      /* two vectors orthogonal to the community direction (u × z-axis) */
      let ax = -uz
      let ay = 0
      let az = ux
      if (Math.abs(az) < 0.01) { ax = 1; ay = 0; az = 0 }
      const al = Math.hypot(ax, ay, az) || 1
      ax /= al; ay /= al; az /= al
      let bx = uy * az - uz * ay
      let by = uz * ax - ux * az
      let bz = ux * ay - uy * ax
      const bl = Math.hypot(bx, by, bz) || 1
      bx /= bl; by /= bl; bz /= bl
      const ca = s * Math.cos(th) * spread
      const sb = s * Math.sin(th) * spread
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

    const legend = keys.map((k, c) => {
      const sample = picked.find((p) => keyOf(p) === k)
      const rawLabel = (sample?.whereMet || sample?.company || '').trim()
      return {
        key: k,
        label: rawLabel || 'Elsewhere',
        color: CLUSTERS[c % CLUSTERS.length],
      }
    })
    return { nodes, cliqueEdges, legend }
  }, [people])

  const focusIdx = nodes.findIndex((n) => n.p.id === (focusId ?? selectedId))
  const focusPerson = focusIdx >= 0 ? nodes[focusIdx].p : null

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
    const fit = { s: 1, x: 0, y: 0 }
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
        if (!still && Math.abs(view.vry) < 0.0004) view.ry += 0.0007
      }
      const rx = view.rx + (still ? 0 : Math.sin(t * 0.13) * 0.025)
      const cosY = Math.cos(view.ry)
      const sinY = Math.sin(view.ry)
      const cosX = Math.cos(rx)
      const sinX = Math.sin(rx)
      const cx = W / 2
      const cy = H / 2
      const S = Math.min(W, H) * 0.3
      const rot = (p: Vec3) => {
        const X = p[0] * cosY + p[2] * sinY
        let Z = -p[0] * sinY + p[2] * cosY
        const Y = p[1] * cosX - Z * sinX
        Z = p[1] * sinX + Z * cosX
        const k = FOV / (FOV + Z)
        return { x: X * S * k, y: Y * S * k, k, z: Z }
      }
      /* fit the knot to the card: small networks zoom up and stay centered as
       * the view turns; big ones keep the wide-sphere framing */
      const rawYou = rot([0, 0, 0])
      let minX = rawYou.x
      let maxX = rawYou.x
      let minY = rawYou.y
      let maxY = rawYou.y
      for (const n of nodesRef.current) {
        const q = rot(n.pos)
        minX = Math.min(minX, q.x)
        maxX = Math.max(maxX, q.x)
        minY = Math.min(minY, q.y)
        maxY = Math.max(maxY, q.y)
      }
      const ext = Math.max(maxX - minX, maxY - minY) + 60
      const fitS = Math.max(1, Math.min(3.2, (Math.min(W, H) * 0.64) / Math.max(1, ext)))
      fit.s += (fitS - fit.s) * 0.08
      fit.x += ((minX + maxX) / 2 - fit.x) * 0.08
      fit.y += ((minY + maxY) / 2 - fit.y) * 0.08
      const proj = (p: Vec3) => {
        const q = rot(p)
        return { x: cx + (q.x - fit.x) * fit.s, y: cy + (q.y - fit.y) * fit.s, k: q.k, z: q.z }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      const list = nodesRef.current
      const you = proj([0, 0, 0])
      const focus = focusRef.current
      /* when focused, everything that isn't the focus dims */
      const dimOf = (i: number) => (focus >= 0 && i !== focus ? 0.16 : 1)

      const pp = list.map((n) => proj(n.pos))

      /* edges: you -> person, brightness/width carry recency; due edges warm */
      list.forEach((n, i) => {
        const d = depthA(pp[i].z, 1.6)
        const dim = dimOf(i)
        const col = n.due ? WARM : n.color
        ctx.strokeStyle = rgba(col, (0.16 + 0.26 * n.fresh) * d * dim, col)
        ctx.lineWidth = (0.6 + 1.1 * n.fresh + (n.due ? 0.4 : 0)) * pp[i].k
        ctx.beginPath()
        ctx.moveTo(you.x, you.y)
        ctx.lineTo(pp[i].x, pp[i].y)
        ctx.stroke()
      })
      for (const [a, b] of edgesRef.current) {
        const dim = Math.min(dimOf(a), dimOf(b))
        if (dim < 1) continue
        const d = Math.min(depthA(pp[a].z, 1.6), depthA(pp[b].z, 1.6))
        ctx.strokeStyle = rgba(list[a].color, 0.07 + 0.14 * d, list[a].color)
        ctx.lineWidth = 0.8
        ctx.beginPath()
        ctx.moveTo(pp[a].x, pp[a].y)
        ctx.lineTo(pp[b].x, pp[b].y)
        ctx.stroke()
      }

      /* nodes, far to near */
      const order = list.map((_, i) => i).sort((a, b) => pp[b].z - pp[a].z)
      const nextHits: typeof hits = []
      for (const i of order) {
        const n = list[i]
        const q = pp[i]
        const d = depthA(q.z, 1.6)
        const dim = dimOf(i)
        const r = n.r * q.k * (1 + (fit.s - 1) * 0.5)
        const sel = focusRef.current === i
        ctx.fillStyle = rgba(n.color, (0.8 + 0.2 * d) * dim, n.color)
        ctx.beginPath()
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = `rgba(255,255,255,${(sel ? 0.95 : 0.16) * dim})`
        ctx.lineWidth = sel ? 1.5 : 1
        ctx.stroke()
        if (n.due) {
          ctx.strokeStyle = rgba(WARM, 0.75 * dim, WARM)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(q.x, q.y, r + 2.5, 0, Math.PI * 2)
          ctx.stroke()
        }
        if (n.label || sel) {
          let ly = q.y + r + 13
          if (Math.hypot(q.x - you.x, ly - you.y) < 18) ly = q.y - r - 6
          ctx.fillStyle = `rgba(206,216,226,${(0.4 + 0.55 * d) * dim})`
          ctx.font = '500 10px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(sel && !n.label ? firstName(n.p.name) : n.label, q.x, ly)
        }
        nextHits.push({ p: n.p, x: q.x, y: q.y, r: Math.max(r, 7) + 7, z: q.z })
      }

      /* you, a flat anchor at the core */
      const youR = 10 * you.k * (1 + (fit.s - 1) * 0.5)
      ctx.fillStyle = rgba(accent, 0.95, accent)
      ctx.beginPath()
      ctx.arc(you.x, you.y, youR, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(you.x, you.y, youR, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = 'rgba(4,26,22,0.95)'
      ctx.font = '700 10px system-ui, sans-serif'
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
          onSelectRef.current(null)
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
  }, [])

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
            onClick={() => {
              setFocusId(null)
              onSelect(null)
            }}
          >
            ×
          </button>
          <strong>{focusPerson.name}</strong>
          <span className="pg-card-sub">
            {[focusPerson.whereMet, focusPerson.company].filter(Boolean).join(' · ') || 'Met somewhere'}
          </span>
          <span className={`pg-card-stat${daysSince(focusPerson.lastTouch) >= focusPerson.cadenceDays ? ' pg-card-stat--due' : ''}`}>
            {focusPerson.lastTouch && daysSince(focusPerson.lastTouch) <= 0
              ? 'Talked today'
              : focusPerson.lastTouch
                ? `Talked ${daysSince(focusPerson.lastTouch)} ${daysSince(focusPerson.lastTouch) === 1 ? 'day' : 'days'} ago`
                : 'Never logged a touch'}
            {focusPerson.lastTouch ? ` · ${cadenceLabel(focusPerson.cadenceDays)}` : ''}
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
