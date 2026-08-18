export type AlphaFaceMood = 'soft' | 'sharp' | 'bold'

function faceInk(color: string): string {
  const hex = color.trim().replace('#', '')
  if (hex.length < 6) return '#fff'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return '#fff'
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return l > 0.55 ? '#111' : '#fff'
}

export function AlphaFace({
  color,
  mood = 'soft',
  size = 40,
}: {
  color: string
  mood?: AlphaFaceMood
  size?: number
}) {
  const eyeY = mood === 'bold' ? 14 : 15
  const mouth =
    mood === 'soft'
      ? 'M16 28c3 3.5 9 3.5 12 0'
      : mood === 'sharp'
        ? 'M17 29h10'
        : 'M15 27c4 5 10 5 14 0'
  const ink = faceInk(color)
  return (
    <svg
      className="alpha-face"
      width={size}
      height={size}
      viewBox="0 0 44 44"
      aria-hidden
    >
      <circle cx="22" cy="22" r="20" fill={color} stroke="#111" strokeWidth="2.5" />
      <circle cx="15" cy={eyeY} r="2.2" fill={ink} />
      <circle cx="29" cy={eyeY} r="2.2" fill={ink} />
      <path d={mouth} fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}
