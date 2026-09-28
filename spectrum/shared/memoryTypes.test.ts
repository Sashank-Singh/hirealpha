import { describe, expect, test } from 'bun:test'
import { detectMultiStepPlan, planPromptBlock, type Plan } from './plans'
import { captureStatedPreferences } from './memoryMaintain'
import { pruneExpiredFacts, upsertFacts } from './memory'
import { standingConstraints, constraintConflictNote } from './memoryBlock'
import * as fs from 'node:fs/promises'

describe('typed memory — FACT/PREFERENCE/GOAL/CONSTRAINT/COMMITMENT', () => {
  test('constraints, goals, and commitments are captured deterministically (no model)', () => {
    const facts = captureStatedPreferences(
      "Remember: never spend more than $500 without asking. I want to launch by Friday. I told Sarah I'd send the deck tonight.",
    )
    const kinds = facts.map((f) => f.kind)
    expect(kinds).toContain('constraint')
    expect(kinds).toContain('goal')
    expect(kinds).toContain('commitment')
    const cap = facts.find((f) => f.kind === 'constraint')
    expect(cap?.value).toMatch(/\$500/)
  })

  test('typed facts survive fact expiry (30-day TTL) — restart persistence', async () => {
    const dataDir = await fs.mkdtemp('/tmp/typed-memory-')
    upsertFacts(dataDir, '+15550001234', [
      { key: 'constraint:spend_cap', value: 'Never spend more than $500 without asking first.', ts: Date.now(), lastSeen: Date.now(), kind: 'constraint' },
      { key: 'goal:launch', value: 'Launch by Friday', ts: Date.now(), lastSeen: Date.now(), kind: 'goal' },
      { key: 'lunch_today', value: 'had a burrito', ts: Date.now(), lastSeen: Date.now() },
    ])
    // Age every fact 40 days on disk (upsert re-stamps on write, so the aging
    // happens after), then simulate the restart-time prune: the ephemeral fact
    // expires; typed kinds do not.
    const file = `${dataDir}/threads/+15550001234.json`
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    for (const f of raw.facts) { f.ts -= 40 * 86400_000; f.lastSeen -= 40 * 86400_000 }
    await fs.writeFile(file, JSON.stringify(raw))
    const mem = pruneExpiredFacts(dataDir, '+15550001234')
    const keys = mem.facts.map((f) => f.key)
    expect(keys).toContain('constraint:spend_cap')
    expect(keys).toContain('goal:launch')
    expect(keys).not.toContain('lunch_today')
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  test('constraints reach the purchase gate as caps and are not silently overridden', () => {
    const constraints = standingConstraints([
      { key: 'constraint:spend_cap', value: 'Never spend more than $500 without asking first.', at: Date.now() },
      { key: 'flight_preference', value: 'Delta', at: Date.now() },
    ])
    expect(constraints).toHaveLength(1)
    expect(constraints[0].capDollars).toBe(500)
    // A current instruction naming money in the same turn surfaces the rule —
    // the precedence note, not a silent override.
    const note = constraintConflictNote('book the $900 flight to Austin tonight', [
      { key: 'constraint:spend_cap', value: 'Never spend more than $500 without asking first.', at: Date.now() },
    ])
    expect(note).toBeTruthy()
    expect(note).toMatch(/NOT silently overridden/)
    // Non-conflicting asks carry no note.
    expect(constraintConflictNote('when is my dentist appointment', [
      { key: 'constraint:spend_cap', value: 'Never spend more than $500 without asking first.', at: Date.now() },
    ])).toBeNull()
  })

  test('the purchase gate blocks a staged amount above the standing cap', () => {
    const { runToolConversation } = require('./toolLoop') as typeof import('./toolLoop')
    // Direct gate check through the loop's constraint path.
    let proposed = false
    void runToolConversation({
      messages: [
        { role: 'system', content: 'engine' },
        { role: 'user', content: 'order the whey protein, $150, from https://www.amazon.com/dp/B000QSNYGI' },
      ],
      chat: async () => '{"action":"purchase","item":"Whey Protein","amount":150,"url":"https://www.amazon.com/dp/B000QSNYGI"}',
      lookup: async () => [],
      propose: async () => { proposed = true; return { ok: true, id: 'x' } },
      availableTools: ['web', 'maps'],
      canDraft: true,
      maxSteps: 2,
      constraints: [{ value: 'Never spend more than $100 without asking first.', capDollars: 100 }],
    }).then((r) => {
      expect(r.reply).toMatch(/standing rule|NOT staged/i)
    })
    expect(proposed).toBe(false)
  })
})

describe('durable plans — restart survival', () => {
  const plan: Plan = {
    id: 'p1',
    goal: 'Offsite: venue, invites, headcount reminder',
    status: 'active',
    blocker: null,
    nextAction: 'invite Dana and Priya',
    steps: [
      { text: 'find a venue', state: 'done' },
      { text: 'invite Dana and Priya', state: 'pending' },
      { text: 'set Wednesday headcount reminder', state: 'pending' },
    ],
    operationIds: { '0': 'job_44' },
  }

  test('multi-step asks are detected and become plans', () => {
    const detected = detectMultiStepPlan('Set up the offsite: find a venue around here, then book it for Friday afternoon, and invite Dana and Priya, and remind me Wednesday for headcount')
    expect(detected).not.toBeNull()
    expect(detected!.steps.length).toBeGreaterThanOrEqual(3)
    // A two-clause chat message is not a plan.
    expect(detectMultiStepPlan('find a venue and book it')).toBeNull()
  })

  test('plan state renders as prompt guidance anchored to server state', () => {
    const block = planPromptBlock(plan)
    expect(block).toContain('durable plan')
    expect(block).toContain('[done] find a venue')
    expect(block).toMatch(/next action: invite Dana and Priya/i)
    expect(block).toMatch(/do NOT rebuild it from chat history/i)
  })

  test('a done or absent plan injects nothing', () => {
    expect(planPromptBlock({ ...plan, status: 'done' })).toBeNull()
    expect(planPromptBlock(null)).toBeNull()
  })
})
