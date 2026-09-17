/* Reproduce the workshop build path for one ask, step by step:
 * planner -> gate -> sandbox -> inline-script parse. Prints where it breaks. */
import { gmiChat } from '../spectrum/shared/gmi'
import { gateWorkshopCode, runWorkshopCode } from '../deploy/workshop'
import { WORKSHOP_PLANNER } from '../spectrum/shared/liveContext'

const ask = process.argv.slice(2).join(' ') || 'Can you build a ping pong game'

const t0 = Date.now()
console.log(`ask: ${ask}`)
const raw = await gmiChat({
  model: process.env.GMI_MODEL_WORKSHOP || 'zai-org/GLM-5.3-Flash',
  temperature: 0.2,
  maxTokens: 4000,
  timeoutMs: 90_000,
  messages: [
    { role: 'system', content: WORKSHOP_PLANNER },
    { role: 'user', content: ask },
  ],
})
console.log(`planner: ${raw.length} chars in ${Date.now() - t0}ms`)
const jsonMatch = raw.match(/\{[\s\S]*\}/)
if (!jsonMatch) {
  console.log('PLAN FAIL: no JSON in reply. Reply head:\n' + raw.slice(0, 600))
  process.exit(1)
}
let title = ''
let code = ''
try {
  const parsed = JSON.parse(jsonMatch[0]) as { title?: string; code?: string }
  title = String(parsed.title || '')
  code = String(parsed.code || '')
} catch (e) {
  console.log('PLAN FAIL: JSON parse error: ' + (e as Error).message)
  console.log('raw head:\n' + raw.slice(0, 600))
  process.exit(1)
}
console.log(`title: ${title}`)
console.log(`code: ${code.length} chars`)
const trimmed = code.trim()
if (/^<!doctype html|^<html/i.test(trimmed)) {
  console.log('note: reply was raw HTML, wrapping')
  code = "await Bun.write('out/index.html', " + JSON.stringify(trimmed) + ")"
}
const gate = gateWorkshopCode(code)
console.log(`gate: ${gate.ok ? 'ok' : 'BLOCKED: ' + (gate as { reason: string }).reason}`)
if (!gate.ok) process.exit(1)

const t1 = Date.now()
const run = await runWorkshopCode(code)
console.log(`sandbox: ok=${run.ok} files=${run.files.map((f) => f.name + ':' + f.bytes.byteLength).join(',')} in ${Date.now() - t1}ms`)
if (!run.ok) {
  console.log('SANDBOX FAIL:\n' + (run.error || '').slice(0, 2000))
  process.exit(1)
}
const htmlFile = run.files.find((f) => /\.html?$/i.test(f.name))
if (htmlFile) {
  const built = Buffer.from(htmlFile.bytes).toString('utf8')
  const inline = [...built.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!).filter((s) => s.trim())
  console.log(`inline scripts: ${inline.length}`)
  for (const [i, block] of inline.entries()) {
    try {
      new Bun.Transpiler({ loader: 'js' }).transformSync(block)
      console.log(`  script ${i}: parses`)
    } catch (e) {
      console.log(`  script ${i}: PARSE FAIL: ${(e as Error).message}`)
    }
  }
  console.log(`html: ${built.length} chars`)
  console.log(built.slice(0, 400))
}
console.log(`TOTAL ${Date.now() - t0}ms`)
