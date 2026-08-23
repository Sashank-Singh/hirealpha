import { AbsoluteFill, interpolate, Sequence, spring, useCurrentFrame } from 'remotion'

export const VIDEO_FPS = 30
export const VIDEO_DURATION_IN_SECONDS = 33

/* ------------------------------------------------------------------ palette
 * Per-persona colors/faces mirror src/agents/definitions.ts + AlphaFace:
 * friend #2a6f7a soft, coworker #3b5bdb sharp (medium face), cofounder #8b4513 bold.
 */
const ACCENT = '#2a6f7a'
const ACCENT_DEEP = '#1b4d55'
const BG = '#0a0d12'
const BG2 = '#0e1520'
const INK = '#eef3f5'
const MUTED = '#93a3ad'
const CARD = '#141a22'
const CARD_BORDER = '#232e3a'
const SHADOW = 'rgba(0,0,0,0.5)'
const OUT = '#0a84ff' // iMessage sent (dark mode)
const IN_RECV = '#2c2c2e' // iMessage received (dark mode)
const LINK_GRAY = '#8e8e93'
const LINK_BLUE = '#0a84ff'

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

/* ------------------------------------------------------------- message data */
type Msg = {
  dir: 'in' | 'out'
  at: number
  time?: string
  text?: string
  card?: { icon: string; title: string; subtitle: string; accent?: string }
  photo?: boolean
}

const MESSAGES: Msg[] = [
  { dir: 'in', at: 4.4, time: '08:00', text: 'Morning. You slept 7h 25m.', card: { icon: '☀️', title: 'Today · 11:30', subtitle: 'Maria — Software Engineer interview', accent: ACCENT } },
  { dir: 'in', at: 5.6, text: 'Reply “brief” to prep, or open today.' },
  { dir: 'out', at: 7.2, time: '08:04', text: 'prep me for maria' },
  { dir: 'in', at: 8.8, time: '08:04', card: { icon: '🧭', title: 'Maria Chen', subtitle: 'Software Engineer · 11:30 · Met at Zilch', accent: '#5aa9ff' }, text: 'Notes: owns the data platform. Reply “thank you” & I’ll draft it.' },
  { dir: 'out', at: 11.0, time: '10:38', photo: true, text: 'Lunch logged · 34g protein' },
  { dir: 'in', at: 12.8, time: '11:15', text: 'Maria’s interview in 15 min. Inhale — you’ve got this.', card: { icon: '🕑', title: '11:30 · Maria', subtitle: 'Prep card above', accent: '#f6b26b' } },
  { dir: 'out', at: 14.0, time: '11:15', text: 'thanks alpha 🙏' },
  { dir: 'in', at: 15.8, time: '13:12', text: '3 mails — 1 from Maria (recap + next steps).', card: { icon: '✉️', title: 'Mail', subtitle: 'Draft a reply?' } },
  { dir: 'out', at: 17.0, time: '13:12', text: 'draft it' },
  { dir: 'in', at: 18.8, time: '14:00', card: { icon: '⏰', title: 'Reminder', subtitle: 'Send recruiter the references' }, text: 'Firing the reminder you set. Locked-in.' },
  { dir: 'out', at: 20.8, time: '21:00', text: 'how did today go?' },
  { dir: 'in', at: 22.6, time: '21:00', card: { icon: '🌙', title: 'Day closed at 35', subtitle: 'One interview handled · one reply sent · one habit missed', accent: ACCENT }, text: 'Solid day. One habit left — want to knock it out?' },
  { dir: 'out', at: 24.4, time: '21:05', text: 'weekly?' },
  { dir: 'in', at: 26.2, time: '21:05', card: { icon: '📈', title: 'Weekly review', subtitle: '3 days to your offer call. You’re on track.', accent: '#7b6ff0' }, text: 'Strong week. Want the full recap?' },
]

const TYPING_FRAMES = Math.round(0.7 * VIDEO_FPS)

/* ------------------------------------------------------------- link-preview card */
const Card: React.FC<{ c: NonNullable<Msg['card']> }> = ({ c }) => {
  const f = useCurrentFrame()
  const pop = spring({ frame: f, fps: VIDEO_FPS, config: { damping: 18, stiffness: 200 } })
  return (
    <div
      style={{
        marginTop: 8,
        width: 420,
        borderRadius: 14,
        overflow: 'hidden',
        background: '#1c1c1e',
        border: '0.5px solid rgba(255,255,255,0.1)',
        boxShadow: `0 8px 24px ${SHADOW}`,
        transform: `scale(${0.96 + 0.04 * pop})`,
        opacity: pop,
      }}
    >
      <div style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: c.accent ?? ACCENT,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
              flex: 'none',
            }}
          >
            {c.icon}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 16, lineHeight: 1.15 }}>{c.title}</div>
            <div style={{ color: LINK_GRAY, fontSize: 13, marginTop: 2 }}>{c.subtitle}</div>
          </div>
        </div>
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '0.5px solid rgba(255,255,255,0.12)', color: LINK_GRAY, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600, color: '#98989d' }}>hirealpha.chat</span>
          <span>·</span>
          <span>app/mini/friend</span>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- bubble */
const Bubble: React.FC<{ m: Msg }> = ({ m }) => {
  const f = useCurrentFrame()
  const pop = spring({ frame: f, fps: VIDEO_FPS, config: { damping: 16, stiffness: 210 } })
  const out = m.dir === 'out'
  const bg = out ? OUT : IN_RECV
  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', width: '100%', transform: `translateY(${(1 - pop) * 12}px)`, opacity: pop }}>
      <div style={{ position: 'relative', maxWidth: 470 }}>
        {/* tail */}
        <div
          style={{
            position: 'absolute',
            bottom: -4,
            right: out ? 2 : undefined,
            left: out ? undefined : 2,
            width: 18,
            height: 18,
            background: bg,
            transform: 'rotate(45deg)',
            borderRadius: out ? '0 0 0 4px' : '0 0 4px 0',
          }}
        />
        <div
          style={{
            position: 'relative',
            background: bg,
            color: '#fff',
            borderRadius: 18,
            padding: '11px 15px',
            fontSize: 17,
            lineHeight: 1.34,
            borderTopRightRadius: out ? 6 : 18,
            borderTopLeftRadius: out ? 18 : 6,
          }}
        >
          {m.photo && (
            <div
              style={{
                width: 150,
                height: 150,
                borderRadius: 16,
                marginBottom: 8,
                background: 'linear-gradient(135deg, #4a5d38, #2b3a23)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 52,
              }}
            >
              🥗
            </div>
          )}
          {m.text}
          {m.card && <Card c={m.card} />}
          {m.time && (
            <div style={{ color: out ? 'rgba(255,255,255,0.6)' : '#b6b6bb', fontSize: 11, textAlign: out ? 'right' : 'left', marginTop: 4 }}>
              {m.time}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const Typing: React.FC = () => {
  const f = useCurrentFrame()
  const dots = [0, 1, 2].map((i) => spring({ frame: f - i * 4, fps: VIDEO_FPS, config: { damping: 12, stiffness: 220 } }))
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', width: '100%' }}>
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', bottom: -4, left: 2, width: 18, height: 18, background: IN_RECV, transform: 'rotate(45deg)', borderRadius: '0 0 4px 0' }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '13px 16px',
            borderRadius: 18,
            background: IN_RECV,
            borderTopLeftRadius: 6,
            position: 'relative',
          }}
        >
          {dots.map((d, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: 99, background: '#98989d', transform: `scale(${0.6 + d * 0.5})`, opacity: 0.8 }} />
          ))}
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- chat */
const Chat: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        gap: 10,
        padding: '0 22px 28px',
      }}
    >
      {MESSAGES.map((m, i) => {
        const atF = Math.round(m.at * VIDEO_FPS)
        let content: React.ReactNode = null
        if (frame >= atF) {
          content = <Bubble m={m} />
        } else if (m.dir === 'in' && frame >= atF - TYPING_FRAMES) {
          content = <Typing />
        }
        if (content === null) return null
        return (
          <div key={i} style={{ width: '100%', display: 'flex', justifyContent: m.dir === 'out' ? 'flex-end' : 'flex-start' }}>
            {content}
          </div>
        )
      })}
    </div>
  )
}

/* --------------------------------------------------------------- phone */
const Phone: React.FC<{ phoneFrom: number }> = ({ phoneFrom }) => {
  const f = useCurrentFrame()
  const inSpring = spring({ frame: Math.max(0, f - phoneFrom), fps: VIDEO_FPS, config: { damping: 18, stiffness: 120 } })
  const visible = f >= phoneFrom
  const phoneW = 760
  const phoneH = 1580
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: visible ? 1 : 0 }}>
      <div
        style={{
          width: phoneW,
          height: phoneH,
          borderRadius: 92,
          background: '#050506',
          padding: 22,
          boxShadow: `0 40px 90px ${SHADOW}, 0 0 0 2px #1b1b1d`,
          transform: `scale(${0.86 + 0.14 * inSpring}) translateY(${(1 - inSpring) * 60}px)`,
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: 72,
            overflow: 'hidden',
            background: `linear-gradient(160deg, #15171b, #0d0f13 60%, #08090c)`,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}
        >
          <div style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', width: 250, height: 62, borderRadius: 40, background: '#000' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 34px 10px', color: '#fff', fontWeight: 700, fontSize: 16 }}>
            <span>9:41</span>
            <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
              <span>▂▄▆</span>
              <span style={{ fontSize: 15 }}>🔋</span>
            </span>
          </div>
          {/* Messages header */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: '8px 18px 12px' }}>
            <span style={{ color: LINK_BLUE, fontWeight: 500, fontSize: 26, lineHeight: 1, justifySelf: 'start' }}>‹</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifySelf: 'center' }}>
              <Face color={FRIEND.color} mood={FRIEND.mood} size={44} />
              <div style={{ textAlign: 'left' }}>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 19 }}>Alpha</div>
                <div style={{ color: LINK_GRAY, fontSize: 14 }}>Message</div>
              </div>
            </div>
            <span style={{ color: LINK_BLUE, fontWeight: 500, fontSize: 16, justifySelf: 'end' }}>Details</span>
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
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
  const ctaStart = Math.round(28.5 * VIDEO_FPS)
  return (
    <AbsoluteFill style={{ background: BG, fontFamily: sans }}>
      <Sequence durationInFrames={120}>
        <Title />
      </Sequence>
      <Phone phoneFrom={phoneFrom} />
      <Sequence from={ctaStart} durationInFrames={Math.round((VIDEO_DURATION_IN_SECONDS - 28.5) * VIDEO_FPS)}>
        <Cta />
      </Sequence>
    </AbsoluteFill>
  )
}
