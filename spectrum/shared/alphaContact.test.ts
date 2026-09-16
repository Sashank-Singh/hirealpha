import { describe, expect, it } from 'bun:test'
import { buildAlphaVcard, getAlphaContactPhotoB64, resolveAlphaContactPhone } from './alphaContact'

describe('alphaContact', () => {
  it('loads Alpha contact photo as valid PNG base64', () => {
    const b64 = getAlphaContactPhotoB64()
    expect(b64).toBeTruthy()
    expect(b64.length).toBeGreaterThan(10000)
    const buf = Buffer.from(b64, 'base64')
    // PNG file signature: 89 50 4E 47 0D 0A 1A 0A
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50)
    expect(buf[2]).toBe(0x4e)
    expect(buf[3]).toBe(0x47)
  })

  it('builds a complete vCard with photo and custom phone number', () => {
    const vcf = buildAlphaVcard('+12163032166')
    expect(vcf).toContain('BEGIN:VCARD')
    expect(vcf).toContain('VERSION:3.0')
    expect(vcf).toContain('FN:Alpha')
    expect(vcf).toContain('ORG:HireAlpha')
    expect(vcf).toContain('TEL;TYPE=CELL:+12163032166')
    expect(vcf).toContain('PHOTO;ENCODING=b;TYPE=PNG:')
    expect(vcf).toContain('END:VCARD')

    // Verify unfolding preserves the exact base64 data
    const unfolded = vcf.replace(/\r\n /g, '')
    const photoLine = unfolded.split('\r\n').find((l) => l.startsWith('PHOTO;ENCODING=b;TYPE=PNG:'))
    expect(photoLine).toBeTruthy()
    const extractedB64 = photoLine!.replace('PHOTO;ENCODING=b;TYPE=PNG:', '')
    expect(extractedB64).toBe(getAlphaContactPhotoB64())
  })

  it('does not invent a phone number when no assignment is available', () => {
    const vcf = buildAlphaVcard()
    expect(vcf).not.toContain('TEL;TYPE=CELL:')
    expect(vcf).toContain('PHOTO;ENCODING=b;TYPE=PNG:')
  })

  it('uses the conversation-specific provider line', async () => {
    expect(await resolveAlphaContactPhone('+15551234567', '+16282647648')).toBe('+16282647648')
  })
})
