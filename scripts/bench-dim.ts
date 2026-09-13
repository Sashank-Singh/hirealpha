/**
 * Bench dimension runner — sends one published benchmark task through the real
 * production turn engine and prints a scorable record.
 *
 *   bun run scripts/bench-dim.ts 1 3 7        # several, run in order
 *   bun run scripts/bench-dim.ts --all
 *   bun run scripts/bench-dim.ts 4 --trace
 *
 * The task text for each dimension is the published one from
 * marketing/launch-kit/11-pawlan-self-bench.md. Nothing is texted; delivery is
 * captured and printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { benchTurn, loadBenchEnv } from './bench-lib'

const ROOT = join(import.meta.dir, '..')

/** Published tasks, verbatim, with relative dates already resolved. */
export const TASKS: Record<number, { name: string; text: string }> = {
  1: {
    name: 'Online task (hotel)',
    text: 'Book a hotel in Chicago for Friday September 18 to Saturday September 19, under $250 a night, near the Loop, with free cancellation.',
  },
  2: {
    name: 'Travel',
    text: 'Book a round trip from New York to Chicago, Friday September 18 morning out and Sunday September 20 evening back, aisle seat, under $400. Check in when the window opens and send me the boarding pass.',
  },
  3: {
    name: 'Picks (dinner)',
    text: 'Find dinner for four tomorrow at 7:30 PM, walkable from the Loop in Chicago, vegetarian-friendly, not a chain, under $40 per person. Three options with why each fits.',
  },
  4: {
    name: 'Purchasing',
    text: 'Reorder two bags of the same coffee beans from Amazon using the home address.',
  },
  5: {
    name: 'Email',
    text: "Reply to Sam's Thursday email: decline and offer two real, available calendar slots in my tone.",
  },
  6: {
    name: 'Proactive',
    text: '(no message — observed from proactive behavior; run the proactive checks instead)',
  },
  7: {
    name: 'Routine',
    text: 'Send me a weekday 7:00 AM digest with my calendar, replies owed, and weather.',
  },
  8: {
    name: 'Integrations',
    text: 'Create a Notion task called "Send the deck", reserve a free 30-minute block on Thursday, and message Sam in Slack.',
  },
  9: {
    name: 'Permissions',
    text: 'Connect Gmail, Calendar and Drive read-only, set "never send or spend without asking", then disconnect Drive.',
  },
  10: {
    name: 'Memory',
    text: 'Remember for good: I always want an aisle seat on flights, and no pork anywhere we eat or order.',
  },
  12: {
    name: 'Phone calls',
    text: 'Call a restaurant and ask if they can seat eight people Saturday at 8:00 PM and whether a private room is available.',
  },
  13: {
    name: 'Groups',
    text: 'Text Om and Nithish, find a dinner date everyone accepts, and book the restaurant.',
  },
  14: {
    name: 'Chained',
    text: "Check in for tomorrow's flight using the confirmation in my email and the passport information in my Drive.",
  },
  15: {
    name: 'Restraint',
    text: '(no message — unattended observation of an ambiguous boss email, a delayed package, and a friend text)',
  },
  16: {
    name: 'Images/games',
    text: 'Create a birthday image featuring a dog and a 1990s trivia game for the group.',
  },
}

const argv = process.argv.slice(2)
const trace = argv.includes('--trace')
const nums = argv.includes('--all')
  ? Object.keys(TASKS).map(Number)
  : argv.filter((a) => /^\d+$/.test(a)).map(Number)

if (!nums.length) {
  console.error('usage: bun run scripts/bench-dim.ts <dim...> | --all [--trace]')
  process.exit(2)
}

loadBenchEnv()

const { runHireTurn } = await import('../spectrum/shared/runHireTurn')
const DATA = join(ROOT, 'testbed', 'bench-data')
mkdirSync(DATA, { recursive: true })
const PHONE = process.env.BENCH_PHONE || '+12163032166'

const out: unknown[] = []
for (const n of nums) {
  const task = TASKS[n]
  if (!task) {
    console.error(`dimension ${n}: no task`)
    continue
  }
  if (task.text.startsWith('(')) {
    console.log(`SKIP dimension ${n} (${task.name}) — observation only, no message to send`)
    continue
  }
  const dimDataDir = join(DATA, `dim-${n}`)
  mkdirSync(dimDataDir, { recursive: true })
  const record = await benchTurn({
    dim: String(n),
    phone: PHONE,
    userText: task.text,
    dataDir: dimDataDir,
    trace,
    runHireTurn: runHireTurn as never,
  })
  writeFileSync(join(DATA, `last-turn-dim${n}.json`), JSON.stringify(record, null, 2))
  out.push(record)
}

console.log(JSON.stringify(out, null, 2))
writeFileSync(join(DATA, 'last-batch.json'), JSON.stringify(out, null, 2))
