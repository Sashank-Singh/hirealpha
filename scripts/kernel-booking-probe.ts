/**
 * End-to-end proof for the benchmark's booking dimension: run the real agent
 * loop on a Kernel cloud browser against a live hotel search, and report what
 * the run actually returned. This is the shape the worker runs, minus the
 * Postgres queue.
 *
 *   KERNEL_API_KEY=... bun run scripts/kernel-booking-probe.ts
 */
import { KernelBrowser } from '../deploy/kernelPage'
import { runKernelTask } from '../deploy/kernelSession'
import { writeFileSync } from 'node:fs'

const key = process.env.KERNEL_API_KEY
if (!key) throw new Error('KERNEL_API_KEY is required')

const url =
  process.argv[2] ||
  'https://www.booking.com/searchresults.html?ss=Chicago+Loop&checkin=2026-09-18&checkout=2026-09-19&group_adults=2&no_rooms=1&group_children=0&nflt=free_cancellation%3D1'
const goal =
  process.argv[3] ||
  'Find a hotel in the Chicago Loop for September 18 to 19 under $250 a night with free cancellation. Report the hotel name, the nightly price, and the cancellation terms.'

const browser = await KernelBrowser.launch({ apiKey: key, timeoutSeconds: 900 })
console.log('session', browser.sessionId)
console.log('live view', browser.liveViewUrl)

const progress: string[] = []
try {
  const outcome = await runKernelTask(
    {
      url,
      goal,
      onProgress: async (event) => {
        progress.push(`${event.action} @ ${event.url}`.slice(0, 160))
      },
      onScreenshot: async (event) => {
        if (!event.dataUrl) return
        const base64 = event.dataUrl.replace(/^data:image\/\w+;base64,/, '')
        writeFileSync('/tmp/kernel-run.jpg', Buffer.from(base64, 'base64'))
      },
      onHandoff: async (handoff) => {
        console.log('HANDOFF', handoff.kind, '-', handoff.message)
        // A probe has no human: report the wall instead of pretending to pass.
        return 'cancelled'
      },
    },
    browser,
  )
  console.log('steps:')
  for (const line of progress.slice(-12)) console.log('  ', line)
  console.log('outcome:', outcome.ok ? 'OK' : `FAILED — ${outcome.error}`)
  if (outcome.ok) console.log('content:\n', outcome.content)
} finally {
  await browser.close()
  console.log('session closed')
}
