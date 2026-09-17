/**
 * OTLP/HTTP-JSON span export for the browser-worker.
 *
 * Zero dependencies on purpose: the worker image installs from the lockfile
 * and a new runtime dep has already cost this repo two deploy outages, so
 * spans are serialised by hand to the protocol Honeycomb already speaks. The
 * env vars are the standard OTel ones, so swapping in the official SDK later
 * is a drop-in.
 *
 * Telemetry is never allowed to change a task's outcome: an unconfigured
 * worker records nothing, a failed export is logged and dropped, and every
 * network call is time-boxed.
 */
import os from 'node:os'

export type TelemetryValue = string | number | boolean | null | undefined
export type TelemetryAttrs = Record<string, TelemetryValue>

export type SpanHandle = {
  readonly traceId: string
  readonly spanId: string
  /** Record attributes on a span that has not ended yet. */
  set(attrs: TelemetryAttrs): void
  /** Finish the span; `error` flips its status and attaches an exception event. */
  end(attrs?: TelemetryAttrs, error?: unknown): void
  /** Start a child span. Children of a finished span still export with its id. */
  child(name: string, attrs?: TelemetryAttrs): SpanHandle
}

type ExportedSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startUnixNano: string
  endUnixNano: string
  attrs: TelemetryAttrs
  events: Array<{ name: string; timeUnixNano: string; attrs: TelemetryAttrs }>
  error: boolean
}

const SCOPE_NAME = 'hirealpha.browser'
const SCOPE_VERSION = '1.0.0'
const MAX_QUEUE = 500
const FLUSH_TIMEOUT_MS = 5_000
const FLUSH_BATCH = 25

export type TelemetryConfig = {
  endpoint: string
  headers: Record<string, string>
  serviceName: string
  redact: boolean
}

function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (raw || '').split(',')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

/** Resolve the exporter target from standard OTEL_* vars, with
 * HONEYCOMB_API_KEY as the one-key convenience path. Empty when unconfigured,
 * which is what keeps telemetry a no-op by default. */
export function telemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig | null {
  if (env.HIREALPHA_TELEMETRY === 'off') return null
  const honeycombKey = env.HONEYCOMB_API_KEY?.trim() || ''
  const headers = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS)
  if (honeycombKey && !headers['x-honeycomb-team']) headers['x-honeycomb-team'] = honeycombKey
  const authHeaderPresent = Object.keys(headers).length > 0
  if (!honeycombKey && !authHeaderPresent) return null

  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, '')
  const endpoint =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    (base ? `${base}/v1/traces` : '') ||
    (honeycombKey ? 'https://api.honeycomb.io/v1/traces' : '')
  if (!endpoint) return null

  return {
    endpoint,
    headers,
    serviceName: env.OTEL_SERVICE_NAME?.trim() || 'hirealpha-browser-worker',
    redact: env.HIREALPHA_TELEMETRY_REDACT === '1',
  }
}

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return telemetryConfig(env) !== null
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

function toNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString()
}

/** Overflow is dropped, not buffered: an unreachable collector must not grow
 * the worker's heap across a long-running container. */
let queue: ExportedSpan[] = []
let flushInFlight: Promise<void> | null = null
let warned = false

function toOtlpValue(value: string | number | boolean) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (typeof value === 'boolean') return { boolValue: value }
  return { stringValue: value }
}

function toOtlpAttrs(attrs: TelemetryAttrs) {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([key, value]) => ({ key, value: toOtlpValue(value as string | number | boolean) }))
}

export function spanToOtlp(span: ExportedSpan) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 1,
    startTimeUnixNano: span.startUnixNano,
    endTimeUnixNano: span.endUnixNano,
    attributes: toOtlpAttrs(span.attrs),
    ...(span.events.length
      ? {
          events: span.events.map((event) => ({
            name: event.name,
            timeUnixNano: event.timeUnixNano,
            attributes: toOtlpAttrs(event.attrs),
          })),
        }
      : {}),
    ...(span.error ? { status: { code: 2 } } : {}),
  }
}

export function buildPayload(spans: ExportedSpan[], config: TelemetryConfig, host = os.hostname()) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: toOtlpAttrs({
            'service.name': config.serviceName,
            'service.version': process.env.HIREALPHA_BUILD_SHA || undefined,
            'deployment.environment': process.env.NODE_ENV || 'development',
            'host.name': host,
          }),
        },
        scopeSpans: [{ scope: { name: SCOPE_NAME, version: SCOPE_VERSION }, spans: spans.map(spanToOtlp) }],
      },
    ],
  }
}

/** Send whatever is queued. Safe to call concurrently; exports overlap rather
 * than serialise behind one another. */
export async function flushTelemetry(): Promise<void> {
  const config = telemetryConfig()
  if (!config || queue.length === 0) return
  const batch = queue
  queue = []
  const send = (async () => {
    try {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...config.headers },
        body: JSON.stringify(buildPayload(batch, config)),
        signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      })
      if (!res.ok && !warned) {
        warned = true
        process.stderr.write(`[telemetry] export rejected (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}\n`)
      }
    } catch (err) {
      if (!warned) {
        warned = true
        process.stderr.write(`[telemetry] export failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  })()
  flushInFlight = send
  await send.finally(() => {
    if (flushInFlight === send) flushInFlight = null
  })
}

function enqueue(span: ExportedSpan): void {
  if (!telemetryEnabled()) return
  if (queue.length >= MAX_QUEUE) return
  queue.push(span)
  if (queue.length >= FLUSH_BATCH) void flushTelemetry()
}

/** Wait for any in-flight export. The worker calls this once per job so a
 * finished job's spans are not lost when the process is replaced by a deploy. */
export async function drainTelemetry(): Promise<void> {
  await flushInFlight?.catch(() => undefined)
  await flushTelemetry()
}

class Span implements SpanHandle {
  readonly traceId: string
  readonly spanId: string
  private readonly parentSpanId?: string
  private readonly name: string
  private readonly startMs: number
  private attrs: TelemetryAttrs
  private events: ExportedSpan['events'] = []
  private ended = false

  constructor(name: string, attrs: TelemetryAttrs, parent?: { traceId: string; spanId: string }, startMs = Date.now()) {
    this.name = name
    this.traceId = parent?.traceId ?? randomHex(16)
    this.spanId = randomHex(8)
    this.parentSpanId = parent?.spanId
    this.attrs = { ...attrs }
    this.startMs = startMs
  }

  set(attrs: TelemetryAttrs): void {
    if (this.ended) return
    Object.assign(this.attrs, attrs)
  }

  child(name: string, attrs: TelemetryAttrs = {}): SpanHandle {
    return new Span(name, attrs, { traceId: this.traceId, spanId: this.spanId })
  }

  end(attrs: TelemetryAttrs = {}, error?: unknown): void {
    if (this.ended) return
    this.ended = true
    Object.assign(this.attrs, attrs)
    const endMs = Date.now()
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : String(error)
      this.events.push({
        name: 'exception',
        timeUnixNano: toNano(endMs),
        attrs: {
          'exception.type': error instanceof Error ? error.name : 'Error',
          'exception.message': message.slice(0, 1000),
          'exception.escaped': true,
        },
      })
    }
    enqueue({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startUnixNano: toNano(this.startMs),
      endUnixNano: toNano(endMs),
      attrs: this.attrs,
      events: this.events,
      error: error !== undefined,
    })
  }
}

/** Start a root span. Returns a no-op handle when telemetry is unconfigured so
 * call sites need no branching. */
export function startSpan(name: string, attrs: TelemetryAttrs = {}): SpanHandle {
  const span = new Span(name, attrs, undefined)
  if (!telemetryEnabled()) {
    return NON_RECORDING
  }
  return span
}

const NON_RECORDING: SpanHandle = {
  traceId: '',
  spanId: '',
  set() {},
  end() {},
  child() {
    return NON_RECORDING
  },
}

/** Free text (a task goal) is what makes a trace debuggable, so it is included
 * truncated unless the operator turns redaction on. Credentials never reach
 * these helpers — the call sites pass hosts, ids and counters only. */
export function traceText(value: string | undefined, config = telemetryConfig()): string | undefined {
  if (!value) return undefined
  if (config?.redact) return undefined
  return value.slice(0, 200)
}

/** Host only: a full URL can carry tokens in its query string. */
export function traceHost(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}

/** For the test harness only. */
export function resetTelemetryQueue(): void {
  queue = []
  flushInFlight = null
  warned = false
}

export function queuedSpanCount(): number {
  return queue.length
}
