/** The invite, kill switch, and loop APIs key on E.164. People type (555) 555 0100. */
export function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (raw.trim().startsWith('+') && digits.length >= 8) return `+${digits}`
  return ''
}
