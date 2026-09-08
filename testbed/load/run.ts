/** Local load test: production burst queue + Friend runtime, simulated I/O only. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createMessageBursts } from '../../spectrum/shared/messageBursts'
import { runHireTurn } from '../../spectrum/shared/runHireTurn'
import { loadMemory } from '../../spectrum/shared/memory'

const flags = new Map(process.argv.slice(2).map(arg => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key!, rest.join('=')] }))
const allowed = ['users', 'rounds', 'ramp-ms', 'fragment-ms', 'model-ms', 'tool-ms', 'timeout-ms', 'p95-ms', 'fail-user-every', 'out']
for (const key of flags.keys()) if (!allowed.includes(key)) throw new Error(`Unknown option --${key}. See testbed/load/README.md`)
function number(key: string, fallback: number, min = 0, max = 600_000) {
  const value = flags.has(key) ? Number(flags.get(key)) : fallback
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid --${key}; expected integer ${min}..${max}`)
  return value
}
const config = {
  users: number('users', 100, 1, 5000), rounds: number('rounds', 2, 1, 100),
  rampMs: number('ramp-ms', 0), fragmentMs: number('fragment-ms', 150, 0, 1500),
  modelMs: number('model-ms', 100), toolMs: number('tool-ms', 50),
  timeoutMs: number('timeout-ms', 120_000, 1000), p95Ms: number('p95-ms', 5000, 1),
  failUserEvery: number('fail-user-every', 0),
}
const out = resolve(flags.get('out') || `testbed/load-results/${new Date().toISOString().replaceAll(':', '-')}`)
const dataDir = mkdtempSync(join(tmpdir(), 'hirealpha-load-'))
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const originalFetch = globalThis.fetch
const envKeys = ['HIREALPHA_API_URL', 'HIREALPHA_INTERNAL_KEY', 'GMI_API_KEY', 'GMI_BASE_URL'] as const
const previousEnv = envKeys.map(key => process.env[key])
process.env.HIREALPHA_API_URL = 'https://load.invalid'
process.env.HIREALPHA_INTERNAL_KEY = 'load-test'
process.env.GMI_API_KEY = 'load-test'
process.env.GMI_BASE_URL = 'https://load.invalid/v1'
let modelCalls = 0, toolCalls = 0, injectedFailures = 0, unexpectedRequests = 0
// All network calls are intercepted. Never fall back to real fetch.
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(String(input))
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.hostname !== 'load.invalid') { unexpectedRequests++; throw new Error(`External network blocked: ${url.hostname}`) }
  if (url.pathname === '/v1/chat/completions') {
    modelCalls++
    await sleep(config.modelMs)
    const messages = body.messages as Array<{ role: string; content: string }>
    const userIndex = messages.findLastIndex(message => message.role === 'user')
    const text = messages[userIndex]?.content || ''
    const id = text.match(/load-user-(\d+)/)?.[0] || ''
    const index = Number(id.replace('load-user-', ''))
    if (config.failUserEvery && id && (index + 1) % config.failUserEvery === 0) {
      injectedFailures++
      return new Response('Simulated provider outage', { status: 503 })
    }
    const actions = messages.slice(userIndex + 1).filter(message => message.role === 'assistant').length
    const content = actions === 0 ? JSON.stringify({ action: 'lookup', tool: 'maps', query: `Chinese restaurant nearby at 8 pm ${id}` })
      : actions === 1 ? JSON.stringify({ action: 'lookup', tool: 'web', query: `Restaurant menu ${id}` })
        : `Result for ${id}: Example Chinese is open at 8 pm. Simulated dinner price: $25. Live Uber pricing is unavailable.`
    return Response.json({ choices: [{ message: { content } }] })
  }
  if (url.pathname === '/api/internal/live/tools') {
    toolCalls++; await sleep(config.toolMs)
    return Response.json({ results: [`SIMULATED result for ${body.message}: Example Chinese, open until 10 pm; menu $25. https://example.com/menu`] })
  }
  if (url.pathname === '/api/internal/live') return Response.json({ found: true, hired: true, name: 'Load tester', timezone: 'America/Los_Angeles', connected: [], context: {}, memories: [] })
  // Read-only context and heartbeat endpoints used by the Friend intake.
  if (url.pathname === '/api/internal/contacts') return Response.json({ contacts: [] })
  if (/inbound|touch/.test(url.pathname)) return Response.json({ ok: true })
  unexpectedRequests++
  throw new Error(`Unmocked endpoint: ${url.pathname}`)
}) as typeof fetch

type Fragment = { user: string; round: number; part: number; text: string; sentAt: number }
type Sample = { user: string; round: number; started: number; elapsed: number; afterLastMs: number; processingMs: number; success: boolean; error: string; fragments: number }
const samples: Sample[] = []
const errors: string[] = []
const completions = new Map<string, () => void>()
const activeUsers = new Set<string>()
let active = 0, peakActive = 0, overlap = 0, mixed = 0, duplicates = 0
const seen = new Set<string>()
let aborted = false
const queue = createMessageBursts<Fragment>({
  run: async items => {
    const first = items[0]!, last = items[items.length - 1]!
    const key = `${first.user}:${first.round}`
    const started = Date.now()
    if (activeUsers.has(first.user)) overlap++
    if (seen.has(key)) duplicates++
    seen.add(key)
    activeUsers.add(first.user); active++; peakActive = Math.max(peakActive, active)
    let error = ''
    try {
      if (items.some(item => item.user !== first.user || item.round !== first.round)) { mixed++; throw new Error('Mixed users/rounds') }
      if (items.length !== 4 || items.some((item, i) => item.part !== i)) throw new Error('Missing or reordered fragments')
      const result = await runHireTurn({ agentId: 'friend', senderId: first.user, dataDir, userText: items.map(item => item.text).join('\n') })
      if (!result.reply.includes(`Result for ${first.user}:`)) throw new Error('Task did not complete with its own result')
      if (result.bubbles.length !== 1) throw new Error('Expected one response')
      const foreign = loadMemory(dataDir, first.user).history.some(message => [...message.content.matchAll(/load-user-\d+/g)].some(match => match[0] !== first.user))
      if (foreign) { mixed++; throw new Error('Cross-user memory contamination') }
    } catch (cause) { error = String(cause) }
    finally {
      active--; activeUsers.delete(first.user)
      samples.push({ user: first.user, round: first.round, started: first.sentAt, elapsed: Date.now() - first.sentAt, afterLastMs: Date.now() - last.sentAt, processingMs: Date.now() - started, success: !error, error, fragments: items.length })
      completions.get(key)?.(); completions.delete(key)
    }
  },
  onError: error => { errors.push(String(error)) },
})
const lag = monitorEventLoopDelay({ resolution: 20 })
lag.enable()
const began = Date.now()
let timer: ReturnType<typeof setTimeout>
try {
  const users = Promise.all(Array.from({ length: config.users }, async (_, index) => {
    await sleep(config.users === 1 ? 0 : index * config.rampMs / (config.users - 1))
    const user = `load-user-${index}`
    for (let round = 0; round < config.rounds && !aborted; round++) {
      const done = new Promise<void>(resolve => completions.set(`${user}:${round}`, resolve))
      const texts = [`Hey I want to [${user}]`, 'go to a Chinese restaurant', 'at 8 pm, find a good one nearby', 'and tell me how much is the Uber']
      for (let part = 0; part < texts.length && !aborted; part++) {
        if (part) await sleep(config.fragmentMs)
        if (!aborted) queue.enqueue(user, { user, round, part, text: texts[part]!, sentAt: Date.now() })
      }
      await done
    }
  }))
  await Promise.race([users, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Load test timed out')), config.timeoutMs) })])
} catch (error) { errors.push(String(error)); aborted = true }
finally { clearTimeout(timer!); lag.disable() }
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]! : 0
const elapsedMs = Date.now() - began
const p95 = percentile(samples.map(sample => sample.afterLastMs), .95)
const failed = samples.filter(sample => !sample.success).length
const passed = samples.length === config.users * config.rounds && failed === 0 && !overlap && !mixed && !duplicates && !unexpectedRequests && !errors.length && p95 <= config.p95Ms
const report = {
  mode: 'simulated services; real Friend runtime and burst queue; no production capacity claim', config, passed,
  elapsedMs, expectedTurns: config.users * config.rounds, completedTurns: samples.length, failedTurns: failed,
  turnsPerSecond: samples.length / (elapsedMs / 1000), peakActive, modelCalls, toolCalls, injectedFailures,
  overlap, mixed, duplicates, unexpectedRequests, errors,
  responseAfterLastFragmentMs: { p50: percentile(samples.map(s => s.afterLastMs), .5), p95, p99: percentile(samples.map(s => s.afterLastMs), .99) },
  processingP95Ms: percentile(samples.map(s => s.processingMs), .95),
  eventLoopP99Ms: Number((lag.percentile(99) / 1e6).toFixed(2)), rssMB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'summary.json'), JSON.stringify(report, null, 2))
writeFileSync(join(out, 'samples.json'), JSON.stringify(samples, null, 2))
// Standard JMeter CSV/JTL fields; elapsed includes collection + execution time.
writeFileSync(join(out, 'results.jtl'), 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,bytes,grpThreads,allThreads,Latency,IdleTime,Connect\n' + samples.map(s => [s.started, s.elapsed, 'four-fragment-restaurant', s.success ? 200 : 500, s.success ? 'OK' : 'FAILED', `${s.user}-round-${s.round}`, 'text', s.success, 0, config.users, config.users, s.elapsed, 0, 0].join(',')).join('\n') + '\n')
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
writeFileSync(join(out, 'report.html'), `<!doctype html><meta charset="utf-8"><title>HireAlpha load test</title><style>body{font:16px system-ui;max-width:950px;margin:40px auto;padding:20px;background:#faf9f6;color:#222}pre{white-space:pre-wrap}strong{color:${passed ? '#17613c' : '#ad2727'}}</style><h1>HireAlpha: ${config.users} simulated users</h1><p><strong>${passed ? 'PASS' : 'FAIL'}</strong> · ${samples.length} turns · ${failed} failed · p95 ${p95} ms after the last text</p><p>Real message grouping and Friend runtime. Model, tools, and delivery are simulated. This does not establish production capacity.</p><h2>Results</h2><pre>${escape(JSON.stringify(report, null, 2))}</pre>`)
console.log(JSON.stringify(report, null, 2))
console.log(`Report: ${join(out, 'report.html')}`)
// On timeout terminate this standalone test process before restoring real I/O.
if (aborted) process.exit(1)
globalThis.fetch = originalFetch
envKeys.forEach((key, i) => { if (previousEnv[i] === undefined) delete process.env[key]; else process.env[key] = previousEnv[i] })
rmSync(dataDir, { recursive: true, force: true })
process.exit(passed ? 0 : 1)
