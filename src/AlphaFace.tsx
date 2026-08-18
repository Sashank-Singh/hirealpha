export type AlphaFaceMood = 'soft' | 'sharp' | 'bold'

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
  return (
    <svg
      className="alpha-face"
      width={size}
      height={size}
      viewBox="0 0 44 44"
      aria-hidden
    >
      <circle cx="22" cy="22" r="20" fill={color} stroke="#111" strokeWidth="2.5" />
      <circle cx="15" cy={eyeY} r="2.2" fill="#fff" />
      <circle cx="29" cy={eyeY} r="2.2" fill="#fff" />
      <path d={mouth} fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}
