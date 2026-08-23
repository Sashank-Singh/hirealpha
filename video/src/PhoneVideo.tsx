import { AbsoluteFill, interpolate, Sequence, spring, useCurrentFrame } from 'remotion'

export const VIDEO_FPS = 30
export const VIDEO_DURATION_IN_SECONDS = 33

/* ------------------------------------------------------------------ palette */
const ACCENT = '#2a6f7a'
const ACCENT_DEEP = '#1b4d55'
const BG = '#0a0d12'
const BG2 = '#0e1520'
const INK = '#eef3f5'
const MUTED = '#93a3ad'
const CARD = '#141a22'
const CARD_BORDER = '#25323a'
const SHADOW = 'rgba(0,0,0,0.5)'
const LINK_BLUE = '#0a84ff'
const SENT = '#3478f6' // iMessage sent blue
const RECV = '#26262a' // iMessage received (dark)
const TEXT = '#e8e8ea'
const SUB = '#98989d'
const ORANGE = 'linear-gradient(135deg, #ff9a3d, #e2631f 55%, #b94a12)'

const sans =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

const FRIEND = { color: '#2a6f7a', mood: 'soft' as const }
const COWORKER = { color: '#3b5bdb', mood: 'sharp' as const }
const COFOUNDER = { color: '#8b4513', mood: 'bold' as const }

function faceInk(color: string): string {
  const hex = color.trim().replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return '#fff'
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return l > 0.55 ? '#111' : '#fff'
}

/** The brand face from src/AlphaFace (used as the product mark in title/CTA). */
const Face: React.FC<{ color: string; mood?: 'soft' | 'sharp' | 'bold'; size?: number }> = ({
  color,
  mood = 'soft',
  size = 40,
}) => {
  const eyeY = mood === 'bold' ? 14 : 15
  const mouth =
    mood === 'soft'
      ? 'M16 28c3 3.5 9 3.5 12 0'
      : mood === 'sharp'
        ? 'M17 29h10'
        : 'M15 27c4 5 10 5 14 0'
  const ink = faceInk(color)
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden>
      <circle cx="22" cy="22" r="20" fill={color} stroke="#111" strokeWidth="2.5" />
      <circle cx="15" cy={eyeY} r="2.2" fill={ink} />
      <circle cx="29" cy={eyeY} r="2.2" fill={ink} />
      <path d={mouth} fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

/** The App icon shown on Alpha's message-app link cards (rainbow gradient). */
const AppIcon: React.FC<{ size?: number }> = ({ size = 44 }) => (
  <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden>
    <defs>
      <linearGradient id="rain" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ff5f6d" />
        <stop offset="0.35" stopColor="#ffc371" />
        <stop offset="0.6" stopColor="#6ee7b7" />
        <stop offset="1" stopColor="#60a5fa" />
      </linearGradient>
    </defs>
    <circle cx="22" cy="22" r="21" fill="url(#rain)" stroke="#000" strokeWidth="1" />
  </svg>
)

/* ------------------------------------------------------------- message data
 * The sample day in Maria/software-engineer form, rendered the way it actually
 * arrives in iMessage: a blue Apps tap, the "Apps · Alpha" card, the long brief
 * text, the "Morning brief · Alpha" card, and the evening wrap.
 */
type Msg =
  | { dir: 'in' | 'out'; at: number; kind: 'bubble'; text: string; time?: string; read?: string }
  | { dir: 'in'; at: number; kind: 'app'; title: string; subtitle: string }
  | { dir: 'in' | 'out' | 'center'; at: number; kind: 'date'; text: string }

const MESSAGES: Msg[] = [
  { dir: 'in', at: 4.4, kind: 'app', title: 'Apps · Alpha', subtitle: 'Tap one to open it.' },
  { dir: 'center', at: 6.0, kind: 'date', text: 'Today 8:00 AM' },
  {
    dir: 'in',
    at: 7.0,
    kind: 'bubble',
    text: 'Today: 11:30 AM · Maria (Software Engineer). Show up ready. Reply ok, skip, or tell me what actually matters.',
  },
  { dir: 'in', at: 9.6, kind: 'app', title: 'Morning brief · Alpha', subtitle: '11:30 AM · Maria (Software Engineer). Show up ready.' },
  { dir: 'out', at: 12.0, kind: 'bubble', text: 'Apps', read: 'Read 12:49 AM' },
  { dir: 'in', at: 14.4, kind: 'bubble', text: 'Maria is confirmed. Prep draft, thank-you draft, and your refs are ready. Want me to send the thank-you after?' },
  { dir: 'out', at: 16.6, kind: 'bubble', text: 'send the thank-you', read: 'Delivered' },
  { dir: 'in', at: 18.8, kind: 'bubble', text: 'Sent. I’ll ping you before the call so you can breathe.' },
  { dir: 'center', at: 21.0, kind: 'date', text: 'Today 9:00 PM' },
  {
    dir: 'in',
    at: 22.0,
    kind: 'bubble',
    text: 'Last night was 6h. Protein landed at 41 of 150. Tonight still has 1 on the book. Wrap the rest. Reply done, leftover, or skip.',
  },
  { dir: 'out', at: 25.0, kind: 'bubble', text: 'weekly?', read: 'Delivered' },
  {
    dir: 'in',
    at: 27.0,
    kind: 'bubble',
    text: 'Week closed at 38. One interview handled, one thank-you sent, one habit missed. 3 days to your offer call — you’re on track.',
  },
]

const TYPING_FRAMES = Math.round(0.7 * VIDEO_FPS)

/* --------------------------------------------------------------- bubbles */
const Bubble: React.FC<{ text: string; dir: 'in' | 'out'; read?: string }> = ({ text, dir, read }) => {
  const f = useCurrentFrame()
  const pop = spring({ frame: f, fps: VIDEO_FPS, config: { damping: 16, stiffness: 200 } })
  const out = dir === 'out'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: out ? 'flex-end' : 'flex-start', width: '100%', transform: `translateY(${(1 - pop) * 14}px)`, opacity: pop }}>
      <div style={{ position: 'relative', maxWidth: 470 }}>
        {!out && (
          <div style={{ position: 'absolute', bottom: -4, left: 2, width: 18, height: 18, background: RECV, transform: 'rotate(45deg)', borderRadius: '0 0 4px 0' }} />
        )}
        <div
          style={{
            background: RECV,
            color: TEXT,
            borderRadius: 22,
            padding: '14px 18px',
            fontSize: 16.5,
            lineHeight: 1.4,
            position: 'relative',
            whiteSpace: 'pre-wrap',
          }}
        >
          {text}
        </div>
      </div>
      {read && <div style={{ color: SUB, fontSize: 11, marginTop: 5, paddingRight: 4 }}>{read}</div>}
    </div>
  )
}

const AppCard: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => {
  const f = useCurrentFrame()
  const pop = spring({ frame: f, fps: VIDEO_FPS, config: { damping: 18, stiffness: 200 } })
  return (
    <div style={{ display: 'flex', width: '100%', transform: `translateY(${(1 - pop) * 14}px)`, opacity: pop }}>
      <div style={{ position: 'relative', maxWidth: 500 }}>
        <div style={{ position: 'absolute', bottom: -4, left: 2, width: 18, height: 18, background: RECV, transform: 'rotate(45deg)', borderRadius: '0 0 4px 0' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: RECV, borderRadius: 22, padding: '13px 16px', position: 'relative' }}>
          <AppIcon size={44} />
          <div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>{title}</div>
            <div style={{ color: SUB, fontSize: 13, marginTop: 2 }}>{subtitle}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

const DateLine: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame()
  const o = spring({ frame: f, fps: VIDEO_FPS, config: { damping: 20, stiffness: 160 } })
  return (
    <div style={{ display: 'flex', justifyContent: 'center', width: '100%', opacity: o }}>
      <span style={{ color: SUB, fontSize: 12, fontWeight: 600 }}>{text}</span>
    </div>
  )
}

const Typing: React.FC = () => {
  const f = useCurrentFrame()
  const dots = [0, 1, 2].map((i) => spring({ frame: f - i * 4, fps: VIDEO_FPS, config: { damping: 12, stiffness: 220 } }))
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', width: '100%' }}>
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', bottom: -4, left: 2, width: 18, height: 18, background: RECV, transform: 'rotate(45deg)', borderRadius: '0 0 4px 0' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '14px 18px', borderRadius: 22, background: RECV, position: 'relative' }}>
          {dots.map((d, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: 99, background: '#98989d', transform: `scale(${0.6 + d * 0.5})`, opacity: 0.8 }} />
          ))}
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- chat list */
const Chat: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 12, padding: '0 18px 14px' }}>
      {MESSAGES.map((m, i) => {
        const atF = Math.round(m.at * VIDEO_FPS)
        let content: React.ReactNode = null
        if (frame >= atF) {
          content =
            m.kind === 'bubble' ? <Bubble text={m.text} dir={m.dir} read={m.read} /> : m.kind === 'app' ? <AppCard title={m.title} subtitle={m.subtitle} /> : <DateLine text={m.text} />
        } else if (m.kind !== 'date' && m.dir === 'in' && frame >= atF - TYPING_FRAMES) {
          content = <Typing />
        }
        if (content === null) return null
        return (
          <div key={i} style={{ width: '100%', display: 'flex', justifyContent: m.dir === 'out' ? 'flex-end' : m.dir === 'center' ? 'center' : 'flex-start' }}>
            {content}
          </div>
        )
      })}
      {/* input bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, padding: '8px 0 2px' }}>
        <div style={{ width: 46, height: 46, borderRadius: 99, background: '#3a3a3d', color: '#d8d8dc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 500 }}>+</div>
        <div style={{ flex: 1, height: 52, borderRadius: 26, background: '#1c1c1e', border: '0.5px solid rgba(255,255,255,0.1)', color: SUB, fontSize: 17, display: 'flex', alignItems: 'center', padding: '0 18px' }}>
          iMessage
        </div>
        <div style={{ fontSize: 26 }}>🎤</div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- phone */
const Phone: React.FC<{ phoneFrom: number }> = ({ phoneFrom }) => {
  const f = useCurrentFrame()
  const inSpring = spring({ frame: Math.max(0, f - phoneFrom), fps: VIDEO_FPS, config: { damping: 18, stiffness: 120 } })
  const visible = f >= phoneFrom
  const W = 690
  const H = 1500
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: visible ? 1 : 0 }}>
      <div
        style={{
          width: W,
          height: H,
          borderRadius: 96,
          padding: 5,
          background: ORANGE,
          boxShadow: `0 50px 100px ${SHADOW}`,
          transform: `scale(${0.86 + 0.14 * inSpring}) translateY(${(1 - inSpring) * 60}px)`,
        }}
      >
        {/* black bezel */}
        <div style={{ width: '100%', height: '100%', borderRadius: 90, background: '#050506', overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {/* dynamic island */}
          <div style={{ position: 'absolute', top: 22, left: '50%', transform: 'translateX(-50%)', width: 250, height: 66, borderRadius: 40, background: '#000' }} />

          {/* status bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '22px 34px 6px', color: '#fff', fontWeight: 700, fontSize: 18 }}>
            <span>11:08</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 15 }}>5G <span style={{ color: '#ff453a' }}>19</span></span>
          </div>

          {/* contact header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 28px 0' }}>
            <span style={{ color: LINK_BLUE, fontWeight: 600, fontSize: 26 }}>‹ 176</span>
            <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
              <rect x="0" y="0" width="18" height="20" rx="5" fill={LINK_BLUE} />
              <path d="M20 7l6-4v14l-6-4z" fill={LINK_BLUE} />
              <circle cx="9" cy="12" r="2.4" fill="#0e1520" />
            </svg>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 14 }}>
            <div style={{ width: 108, height: 108, borderRadius: 99, background: 'radial-gradient(circle at 35% 30%, #4b4b8f, #2a2a52)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 52 }}>
              A
            </div>
            <div style={{ marginTop: 12, padding: '6px 20px', borderRadius: 20, background: 'rgba(80,80,80,0.5)', color: '#fff', fontWeight: 700, fontSize: 20 }}>
              Alpha ›
            </div>
          </div>

          {/* conversation */}
          <div style={{ flex: 1, overflow: 'hidden', marginTop: 8 }}>
            <Chat />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}

/* --------------------------------------------------------------- title + cta */
const Title: React.FC = () => {
  const f = useCurrentFrame()
  const fade = interpolate(f, [0, 18, 78, 96], [0, 1, 1, 0], { extrapolateRight: 'clamp' })
  const rise = spring({ frame: f, fps: VIDEO_FPS, config: { damping: 16, stiffness: 120 } })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: fade, background: `radial-gradient(circle at 50% 40%, ${BG2}, ${BG})` }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: `translateY(${(1 - rise) * 30}px)` }}>
        <div style={{ marginBottom: 40, filter: `drop-shadow(0 30px 70px ${SHADOW})` }}>
          <Face color={FRIEND.color} mood={FRIEND.mood} size={170} />
        </div>
        <div style={{ color: INK, fontWeight: 900, fontSize: 92, letterSpacing: -2 }}>HireAlpha</div>
        <div style={{ color: MUTED, fontSize: 34, marginTop: 26, fontWeight: 500 }}>Your day, handled in iMessage.</div>
      </div>
    </AbsoluteFill>
  )
}

const Cta: React.FC = () => {
  const f = useCurrentFrame()
  const fade = interpolate(f, [0, 20], [0, 1], { extrapolateRight: 'clamp' })
  const rise = spring({ frame: f, fps: VIDEO_FPS, config: { damping: 16, stiffness: 110 } })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: fade, background: `rgba(6,9,12,0.72)` }}>
      <div style={{ width: 780, borderRadius: 40, background: `linear-gradient(160deg, ${CARD}, #0d1217)`, border: `1px solid ${CARD_BORDER}`, padding: '54px 48px', boxShadow: `0 40px 90px ${SHADOW}`, transform: `translateY(${(1 - rise) * 40}px)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <Face color={FRIEND.color} mood={FRIEND.mood} size={74} />
            <Face color={COWORKER.color} mood={COWORKER.mood} size={74} />
            <Face color={COFOUNDER.color} mood={COFOUNDER.mood} size={74} />
          </div>
          <div>
            <div style={{ color: INK, fontWeight: 900, fontSize: 44, letterSpacing: -1 }}>Hire Alpha</div>
            <div style={{ color: MUTED, fontSize: 24, marginTop: 6, fontWeight: 500 }}>Friend · Coworker · Cofounder — $19/mo</div>
          </div>
        </div>
        <div style={{ marginTop: 40, height: 2, background: CARD_BORDER, borderRadius: 2 }} />
        <div style={{ marginTop: 34, color: ACCENT, fontWeight: 800, fontSize: 48, letterSpacing: 0.5 }}>hirealpha.chat</div>
        <div style={{ marginTop: 16, color: MUTED, fontSize: 24 }}>One text. A whole life on autopilot.</div>
      </div>
    </AbsoluteFill>
  )
}

/* --------------------------------------------------------------- root scene */
export const PhoneVideo: React.FC = () => {
  const phoneFrom = 90
  const ctaStart = Math.round(29.0 * VIDEO_FPS)
  return (
    <AbsoluteFill style={{ background: BG, fontFamily: sans }}>
      <Sequence durationInFrames={120}>
        <Title />
      </Sequence>
      <Phone phoneFrom={phoneFrom} />
      <Sequence from={ctaStart} durationInFrames={Math.round((VIDEO_DURATION_IN_SECONDS - 29.0) * VIDEO_FPS)}>
        <Cta />
      </Sequence>
    </AbsoluteFill>
  )
}
