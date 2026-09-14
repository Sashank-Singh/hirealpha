import { describe, it, expect } from 'bun:test'
import { parseAgentAction, updateAgentPlan, formatPlanForPrompt, type AgentPlan } from './agentDriver'

describe('agentDriver planning and parser', () => {
  it('parses action with plan, current_subgoal, and observe fields', () => {
    const raw = JSON.stringify({
      plan: ['Open hotel search', 'Set dates and location', 'Extract prices'],
      current_subgoal: 'Open hotel search',
      observe: 'screenshot',
      action: 'click',
      selector: '#search-button',
    })

    const parsed = parseAgentAction(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.type).toBe('click')
    if (parsed && parsed.type === 'click') {
      expect(parsed.selector).toBe('#search-button')
      expect(parsed.observe).toBe('screenshot')
      expect(parsed.current_subgoal).toBe('Open hotel search')
      expect(parsed.plan).toEqual(['Open hotel search', 'Set dates and location', 'Extract prices'])
    }
  })

  it('updates agent plan and advances completed subgoals', () => {
    let plan: AgentPlan | null = null

    // Step 1: establish initial plan
    plan = updateAgentPlan(plan, ['Search flight', 'Filter nonstop', 'Pick cheapest'], 'Search flight')
    expect(plan).not.toBeNull()
    expect(plan?.subgoals).toEqual(['Search flight', 'Filter nonstop', 'Pick cheapest'])
    expect(plan?.currentSubgoal).toBe('Search flight')
    expect(plan?.completedSubgoals).toEqual([])

    // Step 2: advance to next subgoal
    plan = updateAgentPlan(plan, undefined, 'Filter nonstop')
    expect(plan?.currentSubgoal).toBe('Filter nonstop')
    expect(plan?.completedSubgoals).toEqual(['Search flight'])

    // Step 3: advance to final subgoal
    plan = updateAgentPlan(plan, undefined, 'Pick cheapest')
    expect(plan?.currentSubgoal).toBe('Pick cheapest')
    expect(plan?.completedSubgoals).toEqual(['Search flight', 'Filter nonstop'])

    const promptText = formatPlanForPrompt(plan)
    expect(promptText).toContain('ACTIVE SUBGOAL: Pick cheapest')
    expect(promptText).toContain('Completed: Search flight -> Filter nonstop')
  })

  it('handles re-planning when drift is detected', () => {
    let plan: AgentPlan | null = {
      subgoals: ['Search Paris', 'Book hotel'],
      currentSubgoal: 'Search Paris',
      completedSubgoals: [],
    }

    // Model revised plan when drifting into restaurants
    plan = updateAgentPlan(plan, ['Search Paris hotels specifically', 'Filter 4-star', 'Extract hotel'], 'Search Paris hotels specifically')
    expect(plan?.subgoals).toEqual(['Search Paris hotels specifically', 'Filter 4-star', 'Extract hotel'])
    expect(plan?.currentSubgoal).toBe('Search Paris hotels specifically')
  })
})
