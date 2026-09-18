import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { findInboundVoice, resolveInboundVoiceTurn } from './liveContext'

/** A voice note as Photon hands it over: its own content type, audio mime,
 * and a `read()` that yields the file bytes. */
function voiceNote(over: Record<string, unknown> = {}) {
  return {
    type: 'voice',
    mimeType: 'audio/mp4',
    size: 4096,
    read: async () => Buffer.alloc(4096, 7),
    ...over,
  }
}

describe('findInboundVoice', () => {
  it('finds a bare iMessage voice note', () => {
    const found = findInboundVoice(voiceNote())
    expect(found?.mimeType).toBe('audio/mp4')
  })

  it('finds a voice note inside a text+voice group', () => {
    const found = findInboundVoice({
      type: 'group',
      items: [
        { type: 'text', content: { type: 'text', text: 'listen to this' } },
        { type: 'attachment', content: voiceNote({ type: 'voice', mimeType: 'audio/x-caf' }) },
      ],
    })
    expect(found?.mimeType).toBe('audio/x-caf')
  })

  it('finds a bare audio attachment that did not come through as a voice bubble', () => {
    const found = findInboundVoice(voiceNote({ type: 'attachment', mimeType: 'audio/mpeg' }))
    expect(found?.mimeType).toBe('audio/mpeg')
  })

  it('ignores photos, text, and unreadable audio', () => {
    expect(findInboundVoice({ type: 'attachment', mimeType: 'image/jpeg', read: async () => Buffer.alloc(4096) })).toBeNull()
    expect(findInboundVoice({ type: 'text', text: 'hello' })).toBeNull()
    expect(findInboundVoice({ type: 'voice', mimeType: 'audio/mp4' })).toBeNull()
  })
})

describe('resolveInboundVoiceTurn', () => {
  const realFetch = globalThis.fetch
  const env = { url: process.env.HIREALPHA_API_URL, key: process.env.HIREALPHA_INTERNAL_KEY }

  beforeAll(() => {
    process.env.HIREALPHA_API_URL = 'https://api.test'
    process.env.HIREALPHA_INTERNAL_KEY = 'test-internal-key'
  })

  afterAll(() => {
    globalThis.fetch = realFetch
    if (env.url === undefined) delete process.env.HIREALPHA_API_URL
    else process.env.HIREALPHA_API_URL = env.url
    if (env.key === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
    else process.env.HIREALPHA_INTERNAL_KEY = env.key
  })

  function stubFetch(responder: () => Response) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : {},
      })
      return responder()
    }) as typeof fetch
    return calls
  }

  it('posts the audio to hire-api and returns the transcript as the turn', async () => {
    const calls = stubFetch(() =>
      Response.json({ ok: true, text: 'book me a haircut before Thursday', ms: 850 }),
    )
    const turn = await resolveInboundVoiceTurn('+15551234567', 'friend', voiceNote())
    expect(turn?.userText).toBe('book me a haircut before Thursday')
    expect(turn?.note).toContain('transcription')
    expect(calls[0]!.url).toBe('https://api.test/api/internal/transcribe')
    expect(calls[0]!.body.mimeType).toBe('audio/mp4')
    expect(String(calls[0]!.body.audioBase64).length).toBeGreaterThan(100)
    // The route biases the decoder with this user's own names and places.
    expect(calls[0]!.body.phone).toBe('+15551234567')
    expect(calls[0]!.body.persona).toBe('friend')
  })

  it('carries a typed caption alongside the spoken words', async () => {
    stubFetch(() => Response.json({ ok: true, text: 'push the standup to nine thirty', ms: 400 }))
    const turn = await resolveInboundVoiceTurn('+15551234567', 'friend', {
      type: 'group',
      items: [
        { type: 'attachment', content: voiceNote() },
        { type: 'text', content: { type: 'text', text: 'for tomorrow' } },
      ],
    })
    expect(turn?.userText).toBe('push the standup to nine thirty')
    expect(turn?.note).toContain('for tomorrow')
  })

  it('returns null instead of throwing when the STT route refuses', async () => {
    stubFetch(() => new Response('whisper is down', { status: 502 }))
    expect(await resolveInboundVoiceTurn('+15551234567', 'friend', voiceNote())).toBeNull()
  })

  it('returns null when the transcript comes back empty', async () => {
    stubFetch(() => Response.json({ ok: true, text: '   ', ms: 300 }))
    expect(await resolveInboundVoiceTurn('+15551234567', 'friend', voiceNote())).toBeNull()
  })

  it('never posts a payload too small to be audio', async () => {
    const calls = stubFetch(() => Response.json({ ok: true, text: 'hello', ms: 10 }))
    const turn = await resolveInboundVoiceTurn('+15551234567', 'friend', voiceNote({ read: async () => Buffer.alloc(64) }))
    expect(turn).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
