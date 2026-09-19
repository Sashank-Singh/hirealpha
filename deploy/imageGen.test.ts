import { afterEach, describe, expect, it } from 'bun:test'
import { generateImage, renderPrompt } from './imageGen'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('the render prompt', () => {
  it('carries the no-lettering clause and stays bounded', () => {
    const prompt = renderPrompt('  a dog hosting a 1990s trivia game   for the group ')
    expect(prompt).toContain('no words')
    expect(prompt).toContain('a dog hosting a 1990s trivia game for the group')
    expect(renderPrompt('x'.repeat(900)).length).toBeLessThan(600)
  })

  it('refuses an empty ask instead of rendering nothing', () => {
    expect(renderPrompt('   ')).toContain('no words')
  })
})

describe('generation', () => {
  /* The provider is a free open endpoint; the product must degrade to "no
   * image" rather than to a broken bubble when it answers with prose, a
   * redirect body, or a 200 with an HTML content type. */
  it('returns null when the provider answers with something that is not an image', async () => {
    globalThis.fetch = (async () => new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    expect(await generateImage('a dog')).toBeNull()
  })

  it('returns null on a provider error', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch
    expect(await generateImage('a dog')).toBeNull()
  })

  it('wraps real bytes in a data URL', async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch
    const image = await generateImage('a dog')
    expect(image?.mimeType).toBe('image/jpeg')
    expect(image?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
  })
})

describe('pictures made through the tool engine travel out with the turn', () => {
  it('hands the bytes to the turn once, then forgets them', async () => {
    const { pushTurnImage, takeTurnImages } = await import('../spectrum/shared/imageRequest')
    const image = { dataUrl: 'data:image/jpeg;base64,AA==', mimeType: 'image/jpeg' }
    pushTurnImage('+15550001111', image)
    expect(takeTurnImages('+15550001111')).toEqual([image])
    // Drained: a later turn cannot re-send the previous picture.
    expect(takeTurnImages('+15550001111')).toEqual([])
    // And another thread's turn is unaffected.
    expect(takeTurnImages('+15550002222')).toEqual([])
  })
})

describe('a provider refusal gets a second backend', () => {
  /* Measured live: the first call answered 502 and the turn had already
   * promised a picture. One retry with a seed and, failing that, the flux
   * backend — then an honest null. */
  it('retries once and returns the second attempt when the first refuses', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (calls.length === 1) return new Response('busy', { status: 502 })
      return new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch
    const image = await generateImage('a blue dog')
    expect(calls.length).toBe(2)
    expect(calls[1]).toContain('model=flux')
    expect(calls[1]).toContain('seed=')
    expect(image?.mimeType).toBe('image/png')
  })

  it('gives up honestly after both attempts fail', async () => {
    let n = 0
    globalThis.fetch = (async () => {
      n++
      return new Response('nope', { status: 500 })
    }) as unknown as typeof fetch
    expect(await generateImage('a blue dog')).toBeNull()
    expect(n).toBe(2)
  })
})
