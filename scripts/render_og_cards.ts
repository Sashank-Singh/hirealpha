/**
 * Renders the iMessage card images for every mini-app kind with the current
 * og-template.html, so a change to the card's type scale lands on all of them
 * instead of only the next kind someone happens to regenerate by hand.
 *
 * Usage: bun run scripts/render_og_cards.ts [kind ...]
 */
import { chromium, type Browser } from 'playwright'
import { resolve } from 'node:path'

const OUT_DIR = resolve(process.cwd(), 'public/images/og')
const TEMPLATE = resolve(process.cwd(), 'scripts/og-template.html')
const VAULT_TEMPLATE = resolve(process.cwd(), 'scripts/vault-og.html')

/** Copy of MINI_META in deploy/web-server.ts — the image text and the OG text
 * have to say the same thing, so keep the two tables in step. */
const CARDS: Record<string, { title: string; description: string }> = {
  menu: { title: 'Apps', description: 'Tap one to open it.' },
  apps: { title: 'Apps', description: 'Tap one to open it.' },
  digest: { title: 'Morning brief', description: 'Who is next, what to do, what can wait.' },
  pick_night: { title: 'Evening brief', description: 'The day, wrapped. What is left, and what is on tomorrow.' },
  next_move: { title: 'Next', description: 'One ranked action. Do it, snooze it, or skip it.' },
  nutrition: { title: 'Nutrition', description: 'Log meals, estimate macros, and keep today’s totals.' },
  open_loops: { title: 'Promises', description: 'What you told a person you would do, until you mark it done.' },
  relationship_radar: { title: 'Stay in touch', description: 'See who to reach out to and when.' },
  networking_crm: { title: 'Networking', description: 'People you met and when to follow up.' },
  drop_zone: { title: 'Save for later', description: 'Capture something messy and sort it later.' },
  meeting_mode: { title: 'Meeting mode', description: 'Prep before the meeting and wrap it cleanly after.' },
  decision_ledger: { title: 'Decisions', description: 'Record important calls and revisit the reasoning.' },
  check_in: { title: 'Check-in', description: 'Take a quick pulse on how you are doing.' },
  spiral_options: { title: 'Get unstuck', description: 'Step back and look at the options.' },
  approve_send: { title: 'Approve & send', description: 'Review a draft before it goes out.' },
  approve_investor_note: { title: 'Investor note', description: 'Review an investor update before it goes out.' },
  pick_slot: { title: 'Pick a slot', description: 'Compare times and choose the one that works.' },
  standup_paste: { title: 'Standup', description: 'Turn raw notes into a tight standup.' },
  linear_triage: { title: 'Linear triage', description: 'Triage issues and backlog.' },
  kill_keep_park: { title: 'Kill, keep, park', description: 'Decide what to kill, keep, or park.' },
  hire_decision: { title: 'Hire decision', description: 'Pressure-test the candidate call.' },
  weekly_focus: { title: 'Weekly focus', description: 'Choose what matters this week.' },
  weekly_review: { title: 'Weekly review', description: 'What got done, what slipped, and next week’s focus.' },
  habit_streak: { title: 'Habits', description: 'Build streaks and track daily habits.' },
  mood_tracker: { title: 'Mood', description: 'Log how you feel and spot patterns.' },
  workout_log: { title: 'Workout log', description: 'Log lifts and track PRs.' },
  learning_queue: { title: 'Learning queue', description: 'Save articles, videos, and podcasts.' },
  sleep_tracker: { title: 'Sleep', description: 'Bedtime, wake, and sleep debt.' },
  pipeline_board: { title: 'Pipeline', description: 'Jobs, fundraising, and leads by stage.' },
  gratitude_journal: { title: 'Gratitude', description: 'One sentence a day.' },
  spending_snapshot: { title: 'Spending', description: 'Log spend against a weekly budget.' },
  home: { title: 'Home', description: 'Here is what your life actually looks like.' },
  artifact: { title: 'Your build', description: 'Built by Alpha. Open it, then say keep it or toss it.' },
  builds: { title: 'Your builds', description: 'Everything Alpha built for you, saved in one place.' },
  default: { title: 'HireAlpha', description: 'A live HireAlpha mini-app.' },
}

/** pick_night ships as evening_brief.png — the filename predates the rename. */
function fileNameFor(kind: string): string {
  return kind === 'pick_night' ? 'evening_brief.png' : `${kind}.png`
}

async function launch(): Promise<Browser> {
  const attempts = [{ channel: 'chrome' }, { channel: 'chromium-headless-shell' }, {}]
  let lastError: unknown = null
  for (const options of attempts) {
    try {
      return await chromium.launch({ headless: true, ...options })
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

async function main() {
  const wanted = process.argv.slice(2)
  const kinds = Object.keys(CARDS).filter((kind) => !wanted.length || wanted.includes(kind))
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
    for (const kind of kinds) {
      const card = CARDS[kind]!
      const url = new URL(`file://${TEMPLATE}`)
      url.searchParams.set('t', card.title)
      url.searchParams.set('d', card.description)
      await page.goto(url.toString(), { waitUntil: 'networkidle' })
      await page.screenshot({ path: resolve(OUT_DIR, fileNameFor(kind)) })
      console.log('rendered', fileNameFor(kind))
    }
    const vaultUrl = `file://${VAULT_TEMPLATE}`
    await page.goto(vaultUrl, { waitUntil: 'networkidle' })
    await page.screenshot({ path: resolve(OUT_DIR, 'vault.png') })
    console.log('rendered vault.png')
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
