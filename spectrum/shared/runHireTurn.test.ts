import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendThread, loadMemory } from './memory'
import { detectAgeOrGenZ, runHireTurn } from './runHireTurn'
import { needsConversationPlanner } from './conversationalFriend'

describe('explicit navigation wins over conversation history', () => {
  let dataDir: string
  const originalFetch = globalThis.fetch
  const envKeys = ['HIREALPHA_API_URL', 'HIREALPHA_INTERNAL_KEY', 'GMI_API_KEY'] as const
  let savedEnv: (string | undefined)[]
  let requests: string[]
  let profileUnavailable: boolean
  let hired: boolean
  let modelInputs: string[]
  let answers: string[]
  let intentAnswers: string[]
  let toolRequests: Array<{ want: string; message: string }>
  let drafts: unknown[]
  let connected: string[] | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hirealpha-turn-test-'))
    savedEnv = envKeys.map((key) => process.env[key])
    process.env.HIREALPHA_API_URL = 'https://hirealpha.test'
    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    process.env.GMI_API_KEY = 'test-key'
    requests = []
    profileUnavailable = false
    hired = false
    modelInputs = []
    answers = []
    intentAnswers = []
    toolRequests = []
    drafts = []
    connected = undefined
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/chat/completions')) {
        modelInputs.push(String(init?.body || ''))
        const prompt = String(init?.body || '')
        // The turn-intent classifier has its own scripted queue; by default it
        // sees an ordinary message and says chat.
        if (prompt.includes('You read one iMessage')) {
          const verdict = intentAnswers.shift() ?? '{"kind":"chat"}'
          return Response.json({ choices: [{ message: { content: verdict } }] })
        }
        if (answers.length) {
          const content = (prompt.includes('CAPABILITY MANIFESTO') || prompt.includes('CONVERSATION_ENGINE') || prompt.includes('FAST_CHAT')) ? answers.shift()! : '{"tool":"none","action":"none"}'
          return Response.json({ choices: [{ message: { content } }] })
        }
        return Response.json({ choices: [{ message: { content: "Hey, I'm Alpha, your personal sidekick. Your calendar isn't connected." } }] })
      }
      if (url.endsWith('/api/internal/live/tools')) {
        const call = JSON.parse(String(init?.body))
        toolRequests.push(call)
        return Response.json({ results: [call.want === 'gmail' ? 'id=flight123 from=airline@example.com subject=Flight confirmation. Departure September 8 at 3 PM PDT.' : 'No events September 8, 2 PM to 5 PM PDT.'] })
      }
      if (url.endsWith('/api/internal/propose')) {
        drafts.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true, id: `draft-flight-${drafts.length}` })
      }
      if (url.includes('/api/internal/mini/token')) return new Response('Unavailable', { status: 503 })
      if (profileUnavailable && url.includes('/api/internal/live?')) return new Response('Unavailable', { status: 503 })
      if (hired && url.includes('/api/internal/live?')) return Response.json({ found: true, hired: true, connected: connected ?? (answers.length ? ['gmail', 'calendar', 'drive'] : []), context: {}, memories: [{ key: 'preferred_name', value: 'Test' }, { key: 'city', value: 'Austin' }] })
      return Response.json({ found: false, hired: false })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    envKeys.forEach((key, i) => {
      if (savedEnv[i] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[i]
    })
    rmSync(dataDir, { recursive: true, force: true })
  })

  for (const userText of ["I'm tired of this app", "I didn't spend $80", "Brief me on the second email", "I wish I could sleep for ten hours"]) {
    it(`understands before acting: ${userText}`, async () => {
      hired = true
      answers = ['Tell me what happened.']
      const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText })
      expect(result.reply).toBe('Tell me what happened.')
      expect(result.card).toBeNull()
      // Turn intent is classified first (see turnIntent.ts), so the engine's own
      // prompt is no longer necessarily the first model call. What matters is
      // that the conversation engine saw it and no write was triggered.
      expect(modelInputs.some((input) => input.includes('CONVERSATION_ENGINE'))).toBe(true)
      expect(requests.some(url => /auto-log|mini\/run|brief|reminder/.test(url))).toBe(false)
    })
  }

  it('resolves a contextual follow-up through the model and saves a preference', async () => {
    hired = true
    appendThread(dataDir, 'test-user', [
      { role: 'user', content: 'I prefer vegetarian restaurants.' },
      { role: 'assistant', content: 'Want me to remember that?' },
    ])
    answers = [JSON.stringify({ action: 'use', name: 'remember', input: { key: 'diet', value: 'Vegetarian restaurants' } }), 'Remembered.']
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Yes, please' })
    expect(result.reply).toBe('Remembered.')
    expect(loadMemory(dataDir, 'test-user').facts.find(f => f.key === 'diet')?.value).toBe('Vegetarian restaurants')
    // The engine's call carries the thread and the tool result; the classifier
    // runs before it, so locate the engine turn rather than assuming index 0.
    const engineTurns = modelInputs.filter((input) => input.includes('CONVERSATION_ENGINE'))
    expect(engineTurns[0]).toContain('I prefer vegetarian restaurants.')
    expect(modelInputs.some((input) => input.includes('Remembered: Vegetarian restaurants.'))).toBe(true)
  })

  it('resumes the saved task after connecting without requiring it again', async () => {
    hired = true
    connected = []
    answers = [JSON.stringify({ action: 'use', name: 'connect', input: { connector: 'gmail', request: 'Find my flight confirmation' } }), 'Connect Gmail and tell me when you are back.']
    await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Find my flight confirmation' })
    expect(loadMemory(dataDir, 'test-user').pendingConnection?.request).toBe('Find my flight confirmation')
    connected = ['gmail']
    answers = [JSON.stringify({ action: 'lookup', tool: 'gmail', query: 'subject:flight' }), JSON.stringify({ action: 'use', name: 'finish_pending_task', input: {} }), 'Your flight departs September 8 at 3 PM PDT.']
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Connected, continue' })
    expect(result.reply).toContain('September 8')
    expect(toolRequests).toEqual([expect.objectContaining({ want: 'gmail', message: 'subject:flight' })])
    expect(loadMemory(dataDir, 'test-user').pendingConnection).toBeUndefined()
  })

  for (const prior of ['food', 'calendar']) {
    for (const userText of ['Apps', 'Show me the apps']) {
      it(`${userText}: card only after ${prior}, even when profile and token lookup fail`, async () => {
        appendThread(dataDir, 'test-user', [
          { role: 'user', content: prior === 'food' ? 'I had wings and an eclair' : 'Plan my day for tomorrow' },
          { role: 'assistant', content: prior === 'food' ? 'Want me to find food nearby?' : "Your calendar isn't connected. Connect it first." },
        ])
        const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText })
        expect(result.reply).toBe('')
        expect(result.bubbles).toEqual([])
        expect(result.card?.url).toContain('/app/mini/friend/apps')
        expect(requests.every((url) => url.includes('/api/internal/mini/token'))).toBe(true)
      })
    }
  }

  it('repeated apps requests and a first-ever apps request each get a card', async () => {
    for (const userText of ['Apps', 'Show me the apps', 'Apps']) {
      const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText })
      expect(result.bubbles).toEqual([])
      expect(result.card?.url).toContain('/app/mini/friend/apps')
      expect(result.contactCardFirst).toBeUndefined()
    }
  })

  it('connect calendar gives a direct setup link without inventing connection status', async () => {
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Connect to my calendar' })
    expect(result.reply).toContain('connect=calendar')
    expect(result.reply).not.toMatch(/not connected|isn't connected|I'm Alpha/i)
    expect(requests.some((url) => url.includes('/chat/completions'))).toBe(false)
  })

  it('acknowledges a saved contact without interpreting it as a savings habit', async () => {
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'I did saved already' })
    expect(result.reply).toContain('contact')
    expect(result.reply).not.toMatch(/I'm Alpha|habit|saving already/i)
    expect(requests.some((url) => url.includes('/chat/completions'))).toBe(false)
  })

  it('removes a repeated introduction from a returning user reply', async () => {
    appendThread(dataDir, 'test-user', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: "Hey, I'm Alpha." },
    ])
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'How is it going?' })
    expect(result.reply).not.toMatch(/I'm Alpha|personal sidekick/i)
  })

  it('answers a first request beginning with Hey instead of replacing it with a welcome', async () => {
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Hey, can you explain compound interest?' })
    expect(result.contactCardFirst).toBeUndefined()
    expect(requests.some((url) => url.includes('/chat/completions'))).toBe(true)
  })

  it('uses one compact, token-capped model call for ordinary hired-user chat', async () => {
    hired = true
    answers = ['Doing well. What is up with you?']
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'How is your day going?' })
    expect(result.reply).toBe('Doing well. What is up with you?')
    // Two model calls: the intent classifier first (it gates the fast path —
    // a regex must never silence the engine, cf. "any important emails
    // today?"), then exactly one compact call for the reply the user reads.
    expect(modelInputs).toHaveLength(2)
    const classifier = JSON.parse(modelInputs[0]!) as { messages: Array<{ content: string }> }
    expect(classifier.messages[0]?.content).toContain('You read one iMessage')
    const request = JSON.parse(modelInputs[1]!) as { max_tokens?: number; messages: Array<{ content: string }> }
    // 220 is the ceiling on the reply the user reads; reasoning models are
    // granted their hidden share on top of it (REASONING_TOKEN_HEADROOM).
    const { REASONING_TOKEN_HEADROOM } = await import('./gmi')
    expect(request.max_tokens).toBeLessThanOrEqual(220 + REASONING_TOKEN_HEADROOM)
    expect(request.messages.every((message) => !message.content.includes('CONVERSATION_ENGINE'))).toBe(true)
    expect(request.messages.every((message) => !message.content.includes('Additional callable capabilities'))).toBe(true)
  })

  it('the classifier vetoes the fast path when a plural word breaks the gate regex', async () => {
    // Regression: "any important emails today?" matched no \b…\b alternative
    // ("emails" breaks the "email" boundary), so the fast path answered
    // "no email access on my end" while gmail was connected. The classifier
    // reads it as a request; the finished fast answer must be discarded and
    // the tool engine run instead.
    hired = true
    intentAnswers = ['{"kind":"request","request":{"summary":"check for important emails today","needsLookup":true}}']
    answers = ['no email access on my end']
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'any important emails today?' })
    // Whatever the multi-step engine ends up saying, it is NOT the discarded
    // fast answer, and both decision-makers ran: classifier and engine.
    expect(result.reply).not.toContain('no email access')
    expect(modelInputs.some((body) => body.includes('You read one iMessage'))).toBe(true)
    expect(modelInputs.some((body) => body.includes('CONVERSATION_ENGINE'))).toBe(true)
  })

  it('reports a profile outage without claiming the user needs to reconnect', async () => {
    profileUnavailable = true
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Plan my day for tomorrow' })
    expect(result.reply).toContain('could not load')
    expect(result.reply).not.toMatch(/isn't connected|not connected|sign in/i)
    expect(requests.some((url) => url.includes('/chat/completions'))).toBe(false)
  })

  it('does not replace an actual request with onboarding or save it as a priority', async () => {
    hired = true
    appendThread(dataDir, 'test-user', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'What should I help with most right now?' },
    ])
    await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Explain recursion' })
    expect(modelInputs.length).toBeGreaterThan(0)
    expect(modelInputs.every((body) => !body.includes('You are mid onboarding'))).toBe(true)
    expect(requests.some((url) => url.endsWith('/api/internal/memory'))).toBe(false)
  })

  it('chains mail and calendar lookups into a saved reply, without sending it', async () => {
    hired = true
    answers = [
      'TOOL gmail subject:confirmation from:airline@example.com',
      'TOOL calendar September 8 2 PM to 5 PM PDT',
      'DRAFT_REPLY id=flight123 | body=Thanks, I confirm the September 8 flight.',
      'Your flight does not conflict with your calendar. The reply is ready for your review. Tap Send on the card.',
    ]
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-chain', userText: 'Locate my flight confirmation, check for calendar conflicts, then draft a reply to the airline.' })
    expect(toolRequests.map((r) => r.want)).toEqual(['gmail', 'calendar'])
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ kind: 'reply', messageId: 'flight123' })
    expect(result.reply).toContain('ready for your review')
    expect(result.reply).not.toMatch(/TOOL |DRAFT_/)
    expect(result.card?.url).toContain('draft-flight')
    expect(requests.some((url) => /send-direct|send-mail/.test(url))).toBe(false)
    answers = ['DRAFT_REPLY id=flight123 | body=Please confirm my seat as well.', 'Your second draft is ready for review.']
    const followup = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-chain', userText: 'Draft another reply asking for my seat confirmation.' })
    expect(drafts).toHaveLength(2)
    expect(followup.card?.url).toContain('draft-flight-2')
  })
})

describe('tool-engine gate', () => {
  it('routes a reorder through the tool engine instead of fast chat', () => {
    const memory = { history: [], facts: [], summary: '', pendingConnection: null, pendingSpend: null } as unknown as Parameters<typeof needsConversationPlanner>[1]
    expect(needsConversationPlanner('Reorder two bags of the same coffee beans from Amazon using the home address.', memory)).toBe(true)
    expect(needsConversationPlanner('Can you tell me how much I paid in fall 2024 in campusnet', memory)).toBe(true)
    expect(needsConversationPlanner('check my tuition balance on csuohio', memory)).toBe(true)
    expect(needsConversationPlanner('that sounds good, thanks!', memory)).toBe(false)
  })
})

describe('age and Gen Z detection', () => {
  it('detects Gen Z from user explicit request or slang', () => {
    expect(detectAgeOrGenZ('talk to me in gen z please').isGenZ).toBe(true)
    expect(detectAgeOrGenZ('bro that is no cap fr fr').isGenZ).toBe(true)
    expect(detectAgeOrGenZ('roast me').isGenZ).toBe(true)
  })

  it('detects Gen Z vs older from stated age', () => {
    expect(detectAgeOrGenZ("I'm 22 years old")).toEqual({ isGenZ: true, reason: 'stated age 22', age: 22 })
    expect(detectAgeOrGenZ("I am 45 years old")).toEqual({ isGenZ: false, reason: 'stated age 45', age: 45 })
  })

  it('detects Gen Z vs older from birth year', () => {
    expect(detectAgeOrGenZ('born in 2002')).toEqual({ isGenZ: true, reason: 'stated year 2002' })
    expect(detectAgeOrGenZ('born in 1985')).toEqual({ isGenZ: false, reason: 'stated year 1985' })
  })

  it('detects Gen Z from context or memory', () => {
    expect(detectAgeOrGenZ('hello', { generation: 'gen_z' }).isGenZ).toBe(true)
    expect(detectAgeOrGenZ('hello', { age: '24' }).isGenZ).toBe(true)
    expect(detectAgeOrGenZ('hello', { age: '38' }).isGenZ).toBe(false)
    expect(detectAgeOrGenZ('hello', {}, [{ key: 'birth_year', value: '2001' }]).isGenZ).toBe(true)
  })
})

