import { describe, expect, it } from 'bun:test'
import {
  CAPABILITIES,
  dispatch,
  dispatchSlash,
  handleDelegate,
  looksLikeTaskAsk,
  matchedCapability,
  parseSlash,
  pickContact,
  slashMenu,
  type DispatchContext,
} from './dispatcher'

const ctx: DispatchContext = {
  text: '',
  timezone: 'US/Pacific',
  memories: ['I owe Maya the deck', 'Hired Sarah'],
  context: { subscriptions: 'Netflix|Spotify', toolbox: 'Pomodoro§https://x/b/1', next_meeting: 'Maria' },
  contacts: [
    { name: 'Maya Chen', phone: '+12163032166' },
    { name: 'Dentist Office', phone: '+12165550000' },
  ],
  userName: 'Sashank',
  spending: {
    logs: [{ amount: 15.49, category: 'other', description: 'Netflix', spentAt: '2026-08-20' }],
    weekly: 120,
    budget: 400,
  },
}

describe('slash commands', () => {
  it('parses /name and /name arg', () => {
    expect(parseSlash('/sweep')).toEqual({ name: 'sweep', arg: '' })
    expect(parseSlash('/recall maya promise')).toEqual({ name: 'recall', arg: 'maya promise' })
    expect(parseSlash('hello')).toBeNull()
  })
  it('runs a slash capability', () => {
    expect(dispatchSlash('/tools', ctx)).toContain('Pomodoro')
    expect(dispatchSlash('/bills', ctx)).toContain('Netflix')
  })
  it('menu for / and /help; unknown slash falls through', () => {
    expect(dispatchSlash('/', ctx)).toBe(slashMenu())
    expect(dispatchSlash('/nope', ctx)).toBeNull()
    expect(dispatchSlash('/help', ctx)).toContain('/recall')
  })
  it('menu covers the full capability set', () => {
    const menu = slashMenu()
    for (const name of ['/brief', '/evening', '/workout', '/meal', '/sleep', '/mood', '/spend', '/habits', '/pipeline', '/standup', '/linear', '/decisions', '/weekly', '/network', '/loops', '/later', '/learn', '/build', '/tools', '/recall', '/debrief', '/sweep', '/dump', '/bills', '/travel', '/honest', '/delegate']) {
      expect(menu, name).toContain(name)
    }
  })
  it('delegates via /delegate to the named contact', () => {
    const out = dispatchSlash('/delegate call maya about the deck', ctx)
    expect(out).toContain('Maya Chen')
    expect(out).toContain('sms:')
  })
  it('asks back when no contact matches the task', () => {
    const out = dispatchSlash('/delegate book a teeth cleaning', ctx)
    expect(out).toContain('who handles this')
  })
  it('menu lists every capability', () => {
    for (const c of CAPABILITIES) expect(slashMenu()).toContain(`/${c.name}`)
  })
})

describe('manifest routing', () => {
  it('routes plain-language capability asks', () => {
    expect(dispatch({ ...ctx, text: 'what did I promise maya' })).toContain('Maya')
    expect(dispatch({ ...ctx, text: 'dump: call the dentist, buy milk' })).toContain('Loops:')
    expect(dispatch({ ...ctx, text: 'show me my tools' })).toContain('Pomodoro')
    expect(dispatch({ ...ctx, text: 'how much do I pay for netflix' })).toContain('Netflix')
  })
  it('matchedCapability resolves slash and plain capability asks', () => {
    expect(matchedCapability({ ...ctx, text: '/dump anything' })?.name).toBe('dump')
    expect(matchedCapability({ ...ctx, text: '/honest at 7pm to run' })?.name).toBe('honest')
    expect(matchedCapability({ ...ctx, text: 'dump: call the dentist' })?.name).toBe('dump')
    expect(matchedCapability({ ...ctx, text: 'show me my tools' })?.name).toBe('tools')
  })
  it('matchedCapability is null for normal chat and help', () => {
    expect(matchedCapability({ ...ctx, text: '/help' })).toBeNull()
    expect(matchedCapability({ ...ctx, text: 'hey how was your weekend' })).toBeNull()
  })
  it('answers what can you do with the capability list', () => {
    const out = dispatch({ ...ctx, text: 'what can you do' })
    expect(out).toContain('recall')
    expect(out).toContain('sweep')
  })
  it('returns null for normal chat', () => {
    expect(dispatch({ ...ctx, text: 'hey how was your weekend' })).toBeNull()
    expect(dispatch({ ...ctx, text: 'lol ok' })).toBeNull()
  })
})

describe('tier 4 delegate', () => {
  it('picks the matched contact, retains the draft, and offers send it', () => {
    let retained: { to: string; toName: string; subject: string; body: string } | null = null
    const out = handleDelegate(
      'email maya about the deck this week',
      [{ name: 'Maya Chen', phone: '+12163032166', email: 'maya@x.com' }],
      'Sashank',
      (d) => { retained = d },
    )
    expect(out).toContain('Maya Chen')
    expect(out).toContain('the deck')
    expect(out).toContain('send it')
    expect(retained).toBeTruthy()
    expect(retained!.to).toBe('maya@x.com')
  })
  it('asks back when the ask names nobody on file', () => {
    expect(handleDelegate('book a teeth cleaning', ctx.contacts, 'Sashank')).toContain('who handles this')
  })
  it('asks back when no contact exists', () => {
    const out = handleDelegate('book a flight', [], null)
    expect(out).toContain('who handles this')
  })
  it('detects task asks and skips chat', () => {
    expect(looksLikeTaskAsk('can you order new headphones for me')).toBe(true)
    expect(looksLikeTaskAsk('can you cancel my gym membership')).toBe(true)
    expect(looksLikeTaskAsk('you make my day')).toBe(false)
    expect(looksLikeTaskAsk('can you make dinner plans')).toBe(false)
  })
  it('dispatch falls through to delegate for unmatched task asks', () => {
    const out = dispatch({ ...ctx, text: 'can you call maya about the invoice' })
    expect(out).toContain('fastest path')
    expect(out).toContain('Maya Chen')
  })
  it('unmatched asks with no contact ask back instead of shrugging', () => {
    const out = dispatch({ ...ctx, text: 'can you order a new charger for me' })
    expect(out).toContain('who handles this')
  })
  it('pickContact matches by first name, never guesses', () => {
    expect(pickContact('call maya about the deck', ctx.contacts)?.name).toBe('Maya Chen')
    expect(pickContact('book a teeth cleaning', ctx.contacts)).toBeNull()
  })
})
