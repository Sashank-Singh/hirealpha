import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  buildPayload,
  drainTelemetry,
  queuedSpanCount,
  resetTelemetryQueue,
  spanToOtlp,
  startSpan,
  telemetryConfig,
  telemetryEnabled,
  traceHost,
  traceText,
} from './telemetry'

// process.env is shared across a bun test run, so the key is set once for the
// file and cleared afterwards rather than per-test.
const KEYS = ['HONEYCOMB_API_KEY', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_SERVICE_NAME', 'HIREALPHA_TELEMETRY', 'HIREALPHA_TELEMETRY_REDACT'] as const
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of KEYS) saved[key] = process.env[key]
  for (const key of KEYS) delete process.env[key]
})

afterAll(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('telemetry config', () => {
  it('is off when nothing is configured', () => {
    expect(telemetryConfig({})).toBeNull()
    expect(telemetryEnabled({})).toBe(false)
  })

  it('turns on from HONEYCOMB_API_KEY alone and picks the Honeycomb endpoint', () => {
    const config = telemetryConfig({ HONEYCOMB_API_KEY: 'hc-key' })
    expect(config?.endpoint).toBe('https://api.honeycomb.io/v1/traces')
    expect(config?.headers['x-honeycomb-team']).toBe('hc-key')
    expect(config?.serviceName).toBe('hirealpha-browser-worker')
  })

  it('honours a self-hosted OTLP endpoint without a Honeycomb key', () => {
    const config = telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.internal/', OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc,other=1' })
    expect(config?.endpoint).toBe('https://collector.internal/v1/traces')
    expect(config?.headers).toEqual({ 'x-honeycomb-team': 'abc', other: '1' })
  })

  it('lets a signal-specific endpoint win and never needs a Honeycomb key for it', () => {
    const config = telemetryConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otlp.example/v1/traces', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer x' })
    expect(config?.endpoint).toBe('https://otlp.example/v1/traces')
  })

  it('is disabled outright by the kill switch', () => {
    expect(telemetryConfig({ HONEYCOMB_API_KEY: 'hc-key', HIREALPHA_TELEMETRY: 'off' })).toBeNull()
  })
})

describe('span recording', () => {
  it('records nothing while unconfigured', () => {
    resetTelemetryQueue()
    const span = startSpan('browser.job', { 'browser.job.id': 'j1' })
    span.set({ 'browser.status': 'ok' })
    span.end()
    expect(queuedSpanCount()).toBe(0)
  })

  it('records a span once configured, with timing and attributes', () => {
    process.env.HONEYCOMB_API_KEY = 'hc-key'
    resetTelemetryQueue()
    const span = startSpan('browser.job', { 'browser.job.id': 'j1' })
    span.end({ 'browser.status': 'ok' })
    const payload = buildPayload(
      [
        {
          traceId: span.traceId,
          spanId: span.spanId,
          name: 'browser.job',
          startUnixNano: '1',
          endUnixNano: '2',
          attrs: { 'browser.job.id': 'j1' },
          events: [],
          error: false,
        },
      ],
      telemetryConfig()!,
    )
    const otlpSpan = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    expect(otlpSpan.name).toBe('browser.job')
    expect(otlpSpan.attributes).toContainEqual({ key: 'browser.job.id', value: { stringValue: 'j1' } })
    expect(span.traceId).toHaveLength(32)
    expect(span.spanId).toHaveLength(16)
    expect(queuedSpanCount()).toBe(1)
    delete process.env.HONEYCOMB_API_KEY
  })

  it('links children to the parent span and flips status on error', () => {
    process.env.HONEYCOMB_API_KEY = 'hc-key'
    resetTelemetryQueue()
    const parent = startSpan('browser.job', {})
    const child = parent.child('browser.step.act', { 'browser.action': 'click' })
    child.end({}, new Error('no effect'))
    parent.end()
    expect(child.traceId).toBe(parent.traceId)
    const otlp = spanToOtlp({
      traceId: child.traceId,
      spanId: child.spanId,
      parentSpanId: parent.spanId,
      name: 'browser.step.act',
      startUnixNano: '1',
      endUnixNano: '2',
      attrs: {},
      events: [{ name: 'exception', timeUnixNano: '2', attrs: { 'exception.message': 'no effect' } }],
      error: true,
    })
    expect(otlp.parentSpanId).toBe(parent.spanId)
    expect(otlp.status).toEqual({ code: 2 })
    expect(otlp.events?.[0]?.name).toBe('exception')
    expect(queuedSpanCount()).toBe(2)
    delete process.env.HONEYCOMB_API_KEY
  })

  it('drops spans instead of growing the heap when the queue fills', () => {
    process.env.HONEYCOMB_API_KEY = 'hc-key'
    resetTelemetryQueue()
    // Flush is stubbed out so the queue can be observed at its cap.
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    for (let i = 0; i < 600; i++) startSpan('browser.step', { 'browser.step.index': i }).end()
    expect(queuedSpanCount()).toBeLessThanOrEqual(500)
    globalThis.fetch = realFetch
    resetTelemetryQueue()
    delete process.env.HONEYCOMB_API_KEY
  })
})

describe('redaction helpers', () => {
  it('never sends a URL query string, only the host', () => {
    expect(traceHost('https://portal.example.com/login?token=secret#frag')).toBe('portal.example.com')
    expect(traceHost('not a url')).toBeUndefined()
    expect(traceHost(undefined)).toBeUndefined()
  })

  it('truncates free text and drops it entirely when redaction is on', () => {
    expect(traceText('x'.repeat(500), telemetryConfig({ HONEYCOMB_API_KEY: 'k' }))).toHaveLength(200)
    expect(traceText('fill the form', telemetryConfig({ HONEYCOMB_API_KEY: 'k', HIREALPHA_TELEMETRY_REDACT: '1' }))).toBeUndefined()
  })
})

describe('export failure handling', () => {
  it('swallows a transport failure so a task is never failed by telemetry', async () => {
    process.env.HONEYCOMB_API_KEY = 'hc-key'
    resetTelemetryQueue()
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch
    startSpan('browser.job', {}).end()
    await expect(drainTelemetry()).resolves.toBeUndefined()
    globalThis.fetch = realFetch
    resetTelemetryQueue()
    delete process.env.HONEYCOMB_API_KEY
  })
})
