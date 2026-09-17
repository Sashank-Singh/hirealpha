import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { configuredSttModel, resetSttModelDegraded, sttUrl, transcribeAudio } from './stt'

const realFetch = globalThis.fetch
const env = {
  url: process.env.STT_URL,
  model: process.env.STT_MODEL,
  language: process.env.STT_LANGUAGE,
}

type Call = { url: string; model: string; language: string | null; filename: string; mimeType: string }

/** Capture the multipart request the way the whisper service sees it. */
function stubWhisper(responder: (model: string, call: number) => Response) {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const form = init?.body as FormData
    const file = form.get('file') as File
    const call: Call = {
      url: String(input),
      model: String(form.get('model')),
      language: form.get('language') ? String(form.get('language')) : null,
      filename: file.name,
      mimeType: file.type,
    }
    calls.push(call)
    return responder(call.model, calls.length)
  }) as typeof fetch
  return calls
}

describe('speech to text', () => {
  beforeAll(() => {
    process.env.STT_URL = 'http://whisper.test:8000/v1'
    delete process.env.STT_MODEL
    delete process.env.STT_LANGUAGE
  })

  afterAll(() => {
    globalThis.fetch = realFetch
    for (const [key, value] of [['STT_URL', env.url], ['STT_MODEL', env.model], ['STT_LANGUAGE', env.language]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  afterEach(() => {
    resetSttModelDegraded()
    delete process.env.STT_MODEL
    delete process.env.STT_LANGUAGE
  })

  it('posts the clip to the whisper server with the configured model', async () => {
    const calls = stubWhisper(() => Response.json({ text: '  call mom at six  ' }))
    const out = await transcribeAudio('audio/mp4', new Uint8Array(1024))
    expect(out.text).toBe('call mom at six')
    expect(out.model).toBe('small')
    expect(calls[0]!.url).toBe('http://whisper.test:8000/v1/audio/transcriptions')
    expect(calls[0]!.model).toBe('small')
    expect(calls[0]!.language).toBe('en')
    expect(calls[0]!.filename).toBe('voice.m4a')
  })

  it('names the upload from the real mime type, including iPhone CAF', async () => {
    const calls = stubWhisper(() => Response.json({ text: 'ok' }))
    await transcribeAudio('audio/x-caf', new Uint8Array(1024))
    await transcribeAudio('audio/mpeg; codecs=mp3', new Uint8Array(1024))
    expect(calls[0]!.filename).toBe('voice.caf')
    expect(calls[1]!.filename).toBe('voice.mp3')
  })

  it('does not send a language hint to an English-only model', async () => {
    process.env.STT_MODEL = 'Systran/faster-distil-whisper-small.en'
    const calls = stubWhisper(() => Response.json({ text: 'ok' }))
    await transcribeAudio('audio/mp4', new Uint8Array(1024))
    expect(calls[0]!.model).toBe('Systran/faster-distil-whisper-small.en')
    expect(calls[0]!.language).toBeNull()
  })

  it('honors an explicit STT_LANGUAGE and an empty one', async () => {
    process.env.STT_LANGUAGE = 'es'
    let calls = stubWhisper(() => Response.json({ text: 'ok' }))
    await transcribeAudio('audio/mp4', new Uint8Array(1024))
    expect(calls[0]!.language).toBe('es')

    resetSttModelDegraded()
    process.env.STT_LANGUAGE = ''
    calls = stubWhisper(() => Response.json({ text: 'ok' }))
    await transcribeAudio('audio/mp4', new Uint8Array(1024))
    expect(calls[0]!.language).toBeNull()
  })

  it('falls back to the provisioned model when the configured one fails, then stays there', async () => {
    process.env.STT_MODEL = 'Systran/faster-distil-whisper-small.en'
    const calls = stubWhisper((model) =>
      model === 'Systran/faster-distil-whisper-small.en'
        ? new Response('model not found', { status: 404 })
        : Response.json({ text: 'picked up the fallback' }),
    )

    const first = await transcribeAudio('audio/mp4', new Uint8Array(1024))
    expect(first.text).toBe('picked up the fallback')
    expect(first.model).toBe('Systran/faster-whisper-small')
    expect(calls.map((c) => c.model)).toEqual([
      'Systran/faster-distil-whisper-small.en',
      'Systran/faster-whisper-small',
    ])

    // The dead model is not retried on every later clip: one strike is enough.
    const second = await transcribeAudio('audio/mp4', new Uint8Array(1024))
    expect(second.model).toBe('Systran/faster-whisper-small')
    expect(calls).toHaveLength(3)
  })

  it('throws on a service error instead of blaming the model', async () => {
    process.env.STT_MODEL = 'Systran/faster-distil-whisper-small.en'
    const calls = stubWhisper(() => new Response('whisper is down', { status: 502 }))
    await expect(transcribeAudio('audio/mp4', new Uint8Array(1024))).rejects.toThrow(/Whisper 502/)
    expect(calls).toHaveLength(1)
  })

  it('treats an empty transcript as a failure without a second attempt', async () => {
    process.env.STT_MODEL = 'Systran/faster-distil-whisper-small.en'
    const calls = stubWhisper(() => Response.json({ text: '   ' }))
    await expect(transcribeAudio('audio/mp4', new Uint8Array(1024))).rejects.toThrow(/empty transcript/)
    expect(calls).toHaveLength(1)
  })

  it('exposes the resolved url and model the health path reads', () => {
    expect(sttUrl()).toBe('http://whisper.test:8000/v1')
    expect(configuredSttModel()).toBe('small')
  })
})
