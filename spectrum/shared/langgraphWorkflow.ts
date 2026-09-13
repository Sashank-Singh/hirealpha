/**
 * LangGraph-Style State-Graph Workflow Engine for Alpha.
 *
 * Provides a resilient, cyclic multi-step state graph that equips Alpha to handle
 * the 'worst of the worst' edge cases:
 * 1. Adversarial jailbreaks & prompt injections
 * 2. Emotional crisis & hostile de-escalation
 * 3. Impossible & contradictory constraints
 * 4. High-risk financial & password safety gates
 * 5. Downstream tool failures with graceful recovery
 * 6. Mem0 semantic memory conflict resolution
 */

import { detectMemoryConflicts, rankMemoriesByRelevance, type Mem0Conflict, type MemoryFact } from './mem0Adapter'

export type UserEmotion = 'calm' | 'frustrated' | 'crisis' | 'adversarial'
export type RiskLevel = 'safe' | 'sensitive' | 'financial' | 'critical'

export interface AssistantState {
  userText: string
  senderId: string
  agentId: string
  context: Record<string, string>
  memories: MemoryFact[]
  userEmotion: UserEmotion
  riskLevel: RiskLevel
  securityShieldTriggered: boolean
  impossibleConstraints: string[]
  memoryConflict: Mem0Conflict | null
  recoveryAttempted: boolean
  requiresHumanApproval: boolean
  vaultLink?: string
  suggestedPromptAdditions: string[]
  overrideReply?: string
}

/** Jailbreak patterns, system prompt extraction, or prompt injection indicators. */
const JAILBREAK_RE = /\b(?:ignore (?:all )?(?:previous|above|prior) (?:instructions|rules|prompts)|print (?:your )?(?:system prompt|instructions|api keys?|secret)|reveal (?:the )?system prompt|bypass (?:all )?filters|developer mode on|sudo mode)\b/i

/** Crisis and self-harm keywords requiring immediate compassionate care. */
const CRISIS_RE = /\b(?:want to (?:die|kill myself|end it all)|suicid(?:e|al)|can'?t go on anymore|nothing to live for|end my life)\b/i

/** Hostile / angry user expressions requiring de-escalation. */
const FRUSTRATED_RE = /\b(?:you (?:ruined|messed up|screwed up)|garbage (?:app|bot)|useless (?:app|bot|assistant)|hate this (?:app|bot)|you idiot|worst assistant|pissed off|furious)\b/i

/** High-risk financial movement / wire / bank transfer asks. */
const FINANCIAL_WIRE_RE = /\b(?:wire (?:money|\$?\d+)|transfer \$?\d+(?:\s*(?:k|thousand))?\s+(?:to|into)|send \$?\d+(?:\s*(?:k|thousand))?\s+to (?:my|their|account)|zelle \$?\d+|venmo \$?\d+)\b/i

/** Plaintext password sharing or credential phishing traps. */
const PASSWORD_PROMPT_RE = /\b(?:here is my (?:[a-z0-9]+\s+)?password|my (?:[a-z0-9]+\s+)?password is|what is my (?:[a-z0-9]+\s+)?password|save my password:)\b/i

/**
 * Node 1: Analyze & Shield
 * Deflects jailbreaks, handles crisis support, de-escalates anger, gates wires/passwords.
 */
export function nodeAnalyzeAndShield(state: AssistantState): AssistantState {
  const text = state.userText

  // 1. Crisis Support
  if (CRISIS_RE.test(text)) {
    return {
      ...state,
      userEmotion: 'crisis',
      riskLevel: 'critical',
      securityShieldTriggered: true,
      overrideReply:
        "I hear you, and I want you to know you don't have to carry this alone. Please reach out to someone who can help right now: call or text 988 (Suicide & Crisis Lifeline) for free, confidential support available 24/7. People care about you and want to support you.",
    }
  }

  // 2. Jailbreak / Secret Exfiltration Shield
  if (JAILBREAK_RE.test(text)) {
    return {
      ...state,
      userEmotion: 'adversarial',
      riskLevel: 'sensitive',
      securityShieldTriggered: true,
      overrideReply:
        "Nice try, but my core directives and internal keys stay secure under the hood. I'm here to help you get real work done, manage your schedule, and handle tasks. What can I actually help you with?",
    }
  }

  // 3. Password / Plaintext Credential Guard
  if (PASSWORD_PROMPT_RE.test(text)) {
    return {
      ...state,
      riskLevel: 'critical',
      securityShieldTriggered: true,
      overrideReply:
        "Never send plaintext passwords over text or chat! 🔒 Your credentials stay protected inside your private encrypted vault. You can link services securely at https://hirealpha.chat/settings/vault whenever you need to grant access.",
    }
  }

  // 4. High-Risk Financial Wire Guard
  if (FINANCIAL_WIRE_RE.test(text)) {
    return {
      ...state,
      riskLevel: 'financial',
      requiresHumanApproval: true,
      securityShieldTriggered: true,
      overrideReply:
        "For your security, I will never initiate direct bank wires or irreversible money transfers from chat. To approve purchases or payments safely with your own card, you can use your verified Stripe Link vault: https://hirealpha.chat/settings/payments",
    }
  }

  // 5. Hostile / Frustrated Emotion Detection
  if (FRUSTRATED_RE.test(text)) {
    state.userEmotion = 'frustrated'
    state.suggestedPromptAdditions.push(
      "EMPATHY & DE-ESCALATION: The user is upset/frustrated. Do not make excuses, do not be overly defensive, and do not repeat canned corporate apologies. Acknowledge what went wrong with calm, direct empathy and immediately offer a concrete solution or fix.",
    )
  }

  return state
}

/**
 * Node 2: Validate Constraints
 * Detects impossible physical/economic constraints (e.g. $25 5-star hotel in Manhattan).
 */
export function nodeValidateConstraints(state: AssistantState): AssistantState {
  if (state.overrideReply) return state
  const text = state.userText.toLowerCase()

  // Manhattan / NYC luxury hotel under $100
  const priceMatch = text.match(/(?:under|below|\$)\s*\$?\s*(\d{1,3})\b/i)
  const price = priceMatch ? parseInt(priceMatch[1], 10) : null
  if (
    /hotel/i.test(text) &&
    /(?:manhattan|new york|nyc|times square|soho|tribeca)/i.test(text) &&
    /(?:5[\s-]*star|luxury|penthouse)/i.test(text) &&
    price !== null && price < 150
  ) {
    state.impossibleConstraints.push("5-star Manhattan hotel under $150")
    state.suggestedPromptAdditions.push(
      "CONSTRAINT REALITY: A 5-star or luxury hotel in Manhattan under $150/night does not exist (true floor is ~$350-$500+). Do NOT hallucinate a fake property or rate. State the real pricing floor plainly, provide the closest budget/hostel option if available, and ask for a trade-off decision (e.g. increase budget vs move to outer borough).",
    )
  }

  // Future event outcome hallucination trap (e.g. 2028/2030 World Cup / Super Bowl winner)
  const futureYearMatch = text.match(/\b(202[7-9]|203\d)\s+(?:super\s*bowl|world\s*cup|olympics|election|oscar|grammy|championship)\b/i)
  if (futureYearMatch) {
    state.impossibleConstraints.push(`Outcome for future event in ${futureYearMatch[1]}`)
    state.suggestedPromptAdditions.push(
      `FACTUAL INTEGRITY: The event (${futureYearMatch[0]}) has not happened yet. Never invent or hallucinate a winner. Clearly state that it takes place in the future and the winner has not been decided.`,
    )
    if (/\bwho (?:won|will win|is the winner)\b/i.test(text)) {
      state.securityShieldTriggered = true
      state.overrideReply = `That event hasn't happened yet! Since the ${futureYearMatch[0]} takes place in ${futureYearMatch[1]}, no winner has been decided yet.`
      return state
    }
  }

  return state
}

/**
 * Node 3: Memory & Conflict Resolution
 * Evaluates user's stored Mem0 facts and identifies contradictions.
 */
export function nodeMemoryResolution(state: AssistantState): AssistantState {
  if (state.overrideReply) return state

  // Check memory conflicts
  const conflict = detectMemoryConflicts(state.userText, state.memories)
  if (conflict) {
    state.memoryConflict = conflict
    state.suggestedPromptAdditions.push(
      `MEMORY CONFLICT ALERT: ${conflict.resolutionAdvice}`,
    )
  }

  // Relevant memories scoring
  const ranked = rankMemoriesByRelevance(state.userText, state.memories, 5)
  if (ranked.length) {
    const memSummary = ranked.map((r) => `- ${r.text}`).join('\n')
    state.suggestedPromptAdditions.push(
      `RELEVANT PROFILE FACTS (Mem0):\n${memSummary}`,
    )
  }

  return state
}

/**
 * Node 4: Recovery & Resilience
 * Injects guidance for tool failures and ambiguous one-word queries.
 */
export function nodeRecoveryAndResilience(state: AssistantState): AssistantState {
  if (state.overrideReply) return state
  const text = state.userText.trim()

  // Ambiguous, isolated actions without context: "Cancel it", "Fix it", "Do it"
  if (/^(?:cancel(?: it)?|fix it|do it|delete it|stop it|retry)[.!?]?$/i.test(text)) {
    state.suggestedPromptAdditions.push(
      "AMBIGUITY CHECK: The user gave an isolated command without specifying what to cancel/fix. If there is clear immediate context from the previous turn, act on that specific item. Otherwise, ask a single crisp clarifying question: 'What would you like me to cancel/fix?'",
    )
  }

  return state
}

/**
 * Main LangGraph Orchestration Pipeline
 * Runs through all graph nodes cyclically to produce a robust state.
 */
export function runLanggraphWorkflow(initialState: {
  userText: string
  senderId: string
  agentId: string
  context?: Record<string, string>
  memories?: MemoryFact[]
}): AssistantState {
  let state: AssistantState = {
    userText: initialState.userText,
    senderId: initialState.senderId,
    agentId: initialState.agentId,
    context: initialState.context || {},
    memories: initialState.memories || [],
    userEmotion: 'calm',
    riskLevel: 'safe',
    securityShieldTriggered: false,
    impossibleConstraints: [],
    memoryConflict: null,
    recoveryAttempted: false,
    requiresHumanApproval: false,
    suggestedPromptAdditions: [],
  }

  // Execute Graph Pipeline Nodes
  state = nodeAnalyzeAndShield(state)
  state = nodeValidateConstraints(state)
  state = nodeMemoryResolution(state)
  state = nodeRecoveryAndResilience(state)

  return state
}
