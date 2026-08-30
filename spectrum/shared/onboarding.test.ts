import { describe, expect, it } from 'bun:test'
import {
  CONNECTOR_SUGGEST_LINK,
  extractOnboardingAnswer,
  nextOnboardingText,
  onboardingDoneText,
  onboardingStage,
  runOnboardingTurn,
  suggestConnector,
} from './onboarding'

const NO_MEMORIES: Array<{ key: string; value: string }> = []
const NAMED = [{ key: 'preferred_name', value: 'Sashank' }]
const NAMED_BARE = [{ key: 'name', value: 'Sashank' }]
const NAMED_CITY = [
  { key: 'preferred_name', value: 'Sashank' },
  { key: 'city', value: 'San Francisco' },
]
const ALL = [
  { key: 'preferred_name', value: 'Sashank' },
  { key: 'city', value: 'San Francisco' },
  { key: 'priority', value: 'training' },
]

describe('onboardingStage', () => {
  it('asks for the name first', () => {
    expect(onboardingStage(NO_MEMORIES)).toBe('name')
  })
  it('moves to city once any name key exists', () => {
    expect(onboardingStage(NAMED)).toBe('city')
    expect(onboardingStage(NAMED_BARE)).toBe('city')
  })
  it('moves to priority once city exists', () => {
    expect(onboardingStage(NAMED_CITY)).toBe('priority')
  })
  it('is done when all three exist', () => {
    expect(onboardingStage(ALL)).toBe('done')
  })
  it('ignores empty values', () => {
    expect(onboardingStage([{ key: 'preferred_name', value: '  ' }])).toBe('name')
  })
})

describe('nextOnboardingText', () => {
  it('uses the exact name question', () => {
    expect(nextOnboardingText('name')).toBe('By the way, what should I call you?')
  })
  it('greets by name on the city question', () => {
    expect(nextOnboardingText('city', 'Sashank')).toBe(
      'Good to meet you, Sashank. What city are you in? It makes what I find you actually local.',
    )
  })
  it('falls back to no name on the city question', () => {
    expect(nextOnboardingText('city')).toBe(
      'Good to meet you. What city are you in? It makes what I find you actually local.',
    )
  })
  it('uses the exact priority question', () => {
    expect(nextOnboardingText('priority')).toBe(
      'Last one. What should I help with most right now: food, training, people, work, or just someone to think out loud with?',
    )
  })
  it('keeps every question free of dashes', () => {
    for (const stage of ['name', 'city', 'priority'] as const) {
      for (const text of [nextOnboardingText(stage, 'Jean Pierre'), nextOnboardingText(stage)]) {
        expect(text).not.toMatch(/[\u2014\u2015\u2013\u2212]/)
        expect(text).not.toMatch(/\S - \S/)
      }
    }
    expect(onboardingDoneText('training')).toBe('That is my job then. Talk anytime. I text first sometimes.')
  })
})

describe('extractOnboardingAnswer name', () => {
  it('pulls the name from I am phrasing', () => {
    expect(extractOnboardingAnswer('name', "I'm Sashank")).toBe('Sashank')
    expect(extractOnboardingAnswer('name', 'call me Sash')).toBe('Sash')
    expect(extractOnboardingAnswer('name', 'my name is Sashank Singh')).toBe('Sashank Singh')
  })
  it('pulls a bare capitalized name', () => {
    expect(extractOnboardingAnswer('name', 'Sashank')).toBe('Sashank')
    expect(extractOnboardingAnswer('name', 'Sashank Singh')).toBe('Sashank Singh')
  })
  it('rejects sentences and questions', () => {
    expect(extractOnboardingAnswer('name', 'I think therefore I am')).toBeNull()
    expect(extractOnboardingAnswer('name', "what's up")).toBeNull()
    expect(extractOnboardingAnswer('name', 'The weather is nice today')).toBeNull()
    expect(extractOnboardingAnswer('name', "I'm not sure yet")).toBeNull()
    expect(extractOnboardingAnswer('name', '')).toBeNull()
  })
})

describe('extractOnboardingAnswer city', () => {
  it('strips live in phrasing', () => {
    expect(extractOnboardingAnswer('city', 'I live in San Francisco')).toBe('San Francisco')
    expect(extractOnboardingAnswer('city', "I'm in Austin")).toBe('Austin')
    expect(extractOnboardingAnswer('city', 'in Lisbon')).toBe('Lisbon')
    expect(extractOnboardingAnswer('city', 'San Francisco')).toBeNull()
  })
  it('rejects chat that is not a city', () => {
    expect(extractOnboardingAnswer('city', '')).toBeNull()
    expect(extractOnboardingAnswer('city', 'I love San Francisco and everything about it')).toBeNull()
  })
})

describe('extractOnboardingAnswer priority', () => {
  it('keeps the raw answer capped at 40 chars', () => {
    expect(extractOnboardingAnswer('priority', 'mostly training and food stuff')).toBe(
      'mostly training and food stuff',
    )
    expect(
      (extractOnboardingAnswer('priority', 'work stuff, people stuff, thinking out loud stuff') || '')
        .length,
    ).toBe(40)
    expect(extractOnboardingAnswer('priority', '   ')).toBeNull()
  })
})

describe('runOnboardingTurn', () => {
  const savedUrl = process.env.HIREALPHA_API_URL
  const savedKey = process.env.HIREALPHA_INTERNAL_KEY
  const dropEnv = () => {
    delete process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_INTERNAL_KEY
  }
  const restoreEnv = () => {
    if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
    if (savedKey) process.env.HIREALPHA_INTERNAL_KEY = savedKey
  }

  it('returns null when onboarding is done', async () => {
    dropEnv()
    try {
      expect(await runOnboardingTurn('+15551234', 'friend', 'hey', ALL)).toBeNull()
    } finally {
      restoreEnv()
    }
  })
  it('advances from name to city in one turn without env', async () => {
    dropEnv()
    try {
      const reply = await runOnboardingTurn('+15551234', 'friend', "I'm Sashank", NO_MEMORIES)
      expect(reply).toBe(
        'Good to meet you, Sashank. What city are you in? It makes what I find you actually local.',
      )
    } finally {
      restoreEnv()
    }
  })
  it('closes onboarding after the priority answer', async () => {
    dropEnv()
    try {
      const reply = await runOnboardingTurn('+15551234', 'friend', 'training', NAMED_CITY)
      expect(reply).toBe('That is my job then. Talk anytime. I text first sometimes.')
    } finally {
      restoreEnv()
    }
  })
  it('re-asks the same stage when nothing is extractable', async () => {
    dropEnv()
    try {
      const reply = await runOnboardingTurn('+15551234', 'friend', 'sup', NO_MEMORIES)
      expect(reply).toBe('By the way, what should I call you?')
    } finally {
      restoreEnv()
    }
  })
})

describe('suggestConnector', () => {
  const LINK = CONNECTOR_SUGGEST_LINK
  it('stays quiet when gmail or calendar is already connected', () => {
    expect(suggestConnector("what's my day", ['gmail'])).toBeNull()
    expect(suggestConnector("what's my day", ['calendar'])).toBeNull()
    expect(suggestConnector('check my inbox', ['gmail', 'calendar'])).toBeNull()
  })
  it('fires on day and mail asks with the settings deep link', () => {
    const hit = suggestConnector("what's my day", [])
    expect(hit).not.toBeNull()
    expect(hit!.connectorId).toBe('gmail')
    expect(hit!.text).toBe(
      `I can pull your calendar and mail into that. Connect Google and I am dangerous: ${LINK}`,
    )
    expect(suggestConnector('check my email', [])).not.toBeNull()
    expect(suggestConnector('give me my brief', [])).not.toBeNull()
    expect(suggestConnector('my schedule tomorrow', [])).not.toBeNull()
  })
  it('stays quiet on unrelated chat', () => {
    expect(suggestConnector('lol ok', [])).toBeNull()
    expect(suggestConnector('who won the game', [])).toBeNull()
  })
})
