import { describe, expect, it } from 'bun:test'
import {
  collectAttachments,
  attachmentIsTextLike,
  attachmentIsPdf,
  attachmentToText,
  extractPdfText,
  formatBytes,
  type AttachmentMeta,
} from './attachments'
import type { GmailMimePart } from '../gmailHelpers'

function part(p: Partial<GmailMimePart>): GmailMimePart {
  return p as GmailMimePart
}

describe('collectAttachments', () => {
  it('finds nested attachment parts and keeps their ids', () => {
    const payload = part({
      parts: [
        part({ mimeType: 'text/plain', body: { data: 'aGk=' } }),
        part({
          mimeType: 'multipart/mixed',
          parts: [
            part({ mimeType: 'application/pdf', filename: 'offer.pdf', body: { attachmentId: 'ATT1', size: 1234 } }),
            part({ mimeType: 'text/plain', body: { data: 'aGk=' } }),
            part({ mimeType: 'application/msword', filename: 'terms.doc', body: { attachmentId: 'ATT2', size: 42 } }),
          ],
        }),
      ],
    })
    const atts = collectAttachments(payload)
    expect(atts.map((a) => a.attachmentId)).toEqual(['ATT1', 'ATT2'])
    expect(atts[0]).toMatchObject({ filename: 'offer.pdf', mimeType: 'application/pdf', size: 1234 })
  })

  it('returns nothing for a plain message', () => {
    expect(collectAttachments(part({ mimeType: 'text/plain', body: { data: 'aGk=' } }))).toEqual([])
  })
})

describe('attachment text routing', () => {
  it('treats csv, json, and markdown as text-like, PDFs as pdf, binaries as neither', () => {
    expect(attachmentIsTextLike({ mimeType: 'text/csv', filename: 'r.csv' })).toBe(true)
    expect(attachmentIsTextLike({ mimeType: 'application/octet-stream', filename: 'notes.md' })).toBe(true)
    expect(attachmentIsTextLike({ mimeType: 'application/octet-stream', filename: 'photo.png' })).toBe(false)
    expect(attachmentIsPdf({ mimeType: 'application/pdf', filename: '' })).toBe(true)
    expect(attachmentIsPdf({ mimeType: 'application/octet-stream', filename: 'x.PDF' })).toBe(true)
    expect(attachmentIsPdf({ mimeType: 'text/plain', filename: 'x.txt' })).toBe(false)
  })

  it('formats sizes like a person reads them', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('extractPdfText', () => {
  // A minimal single-object PDF with an UNCOMPRESSED content stream — exactly
  // the shape the extractor must read without any parser dependency.
  const buildPdf = (text: string): Uint8Array => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
    const raw = [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      `4 0 obj << /Length ${stream.length} >>`,
      'stream',
      stream,
      'endstream',
      'endobj',
      '%%EOF',
    ].join('\n')
    return new Uint8Array(Buffer.from(raw, 'latin1'))
  }

  it('extracts literal text from an uncompressed content stream', () => {
    const out = extractPdfText(buildPdf('Offer letter for Dana'))
    expect(out.status).toBe('extracted')
    expect(out.text).toContain('Offer letter for Dana')
  })

  it('multi-page and FlateDecode PDFs read through inflated streams', () => {
    const zlib = require('node:zlib') as typeof import('node:zlib')
    const page = (t: string) => `BT /F1 12 Tf (${t}) Tj ET`
    const deflated = zlib.deflateSync(Buffer.from(page('Page one terms'))).toString('latin1')
    const raw = [
      '%PDF-1.4',
      `3 0 obj << /Length ${deflated.length} /Filter /FlateDecode >>`,
      'stream',
      deflated,
      'endstream',
      'endobj',
      `4 0 obj << /Length ${page('Page two signature').length} >>`,
      'stream',
      page('Page two signature'),
      'endstream',
      'endobj',
      '%%EOF',
    ].join('\n')
    const out = extractPdfText(new Uint8Array(Buffer.from(raw, 'latin1')))
    expect(out.status).toBe('extracted')
    expect(out.text).toContain('Page one terms')
    expect(out.text).toContain('Page two signature')
  })

  it('a scanned PDF (no text operators) reports image_only, never a guess', () => {
    // Streams exist (an image XObject), but no BT/Tj text operators anywhere.
    const raw = [
      '%PDF-1.4',
      '5 0 obj << /Length 16 >>',
      'stream',
      'IMAGEDATA-BYTES',
      'endstream',
      'endobj',
      '%%EOF',
    ].join('\n')
    const out = extractPdfText(new Uint8Array(Buffer.from(raw, 'latin1')))
    expect(out.status).toBe('image_only')
    expect(out.text).toBeUndefined()
  })

  it('a hex-string (Unicode/CID) PDF degrades honestly to partial with a note', () => {
    // Text encoded as hex strings <...> — the literal-string extractor cannot
    // read it, so the honest outcome is partial-with-note or image_only, never
    // confident garbage.
    const stream = 'BT /F1 12 Tf [<004F00660066>] TJ ET'
    const raw = ['%PDF-1.4', `6 0 obj << /Length ${stream.length} >>`, 'stream', stream, 'endstream', 'endobj', '%%EOF'].join('\n')
    const out = extractPdfText(new Uint8Array(Buffer.from(raw, 'latin1')))
    expect(['partial', 'image_only']).toContain(out.status)
    if (out.status === 'partial') expect(out.note).toBeTruthy()
  })

  it('malformed input is refused, not summarized', () => {
    expect(extractPdfText(new Uint8Array(Buffer.from('just some bytes', 'latin1'))).status).toBe('malformed')
    expect(extractPdfText(new Uint8Array(0)).status).toBe('empty')
  })

  it('refuses encrypted PDFs instead of emitting binary noise', () => {
    const raw = '%PDF-1.4\n/Encrypt 7 0 R\ntrailer << /Encrypt 7 0 R >>\n%%EOF'
    expect(extractPdfText(new Uint8Array(Buffer.from(raw, 'latin1'))).status).toBe('encrypted')
  })

  it('attachmentToText labels every family with a status', () => {
    const pdf = attachmentToText({ mimeType: 'application/pdf', filename: 'a.pdf' }, buildPdf('Salary: 120k'))
    expect(pdf.status).toBe('extracted')
    expect(pdf.text).toContain('Salary: 120k')
    const txt = attachmentToText({ mimeType: 'text/plain', filename: 'a.txt' }, new Uint8Array(Buffer.from('line one\nline two')))
    expect(txt.status).toBe('extracted')
    expect(txt.text).toBe('line one\nline two')
    const html = attachmentToText({ mimeType: 'text/html', filename: 'a.html' }, new Uint8Array(Buffer.from('<p>Hello</p>')))
    expect(html.status).toBe('extracted')
    const csv = attachmentToText({ mimeType: 'text/csv', filename: 'a.csv' }, new Uint8Array(Buffer.from('a,b\n1,2')))
    expect(csv.status).toBe('extracted')
    // Binary that only looked text-like is refused, not quoted.
    const junk = attachmentToText({ mimeType: 'application/octet-stream', filename: 'x.txt' }, new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x01, 0xff, 0xfe]))
    expect(junk.status).toBe('unsupported')
    const png = attachmentToText({ mimeType: 'image/png', filename: 'x.png' }, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    expect(png.status).toBe('unsupported')
    const big = attachmentToText({ mimeType: 'text/plain', filename: 'big.txt' }, new Uint8Array(Buffer.from('x'.repeat(20_000_000))))
    expect(big.status).toBe('too_large')
  })
})

describe('attachment meta identity', () => {
  it('keeps the attachment bound to a source it can name', () => {
    const meta: AttachmentMeta = { attachmentId: 'A1', filename: 'offer.pdf', mimeType: 'application/pdf', size: 10 }
    expect(meta.attachmentId).toBe('A1')
  })
})
