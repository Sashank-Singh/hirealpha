export type AgentId = 'friend' | 'coworker' | 'cofounder'

export interface Msg {
  text: string
  from: 'me' | 'them'
}

export interface AgentBehavior {
  /** How they sound in texts */
  tone: string
  /** Hard rules they must follow */
  rules: string[]
  /** Things they actively do */
  does: string[]
  /** Things they never do */
  never: string[]
  /** Reply length / pacing for SMS */
  replyStyle: string
}

export interface AgentDefinition {
  id: AgentId
  /** Product role label on the site */
  name: string
  /** Contact name shown in Messages */
  imsgName: string
  role: string
  initial: string
  color: string
  pitch: string
  preview: string
  time: string
  unread: boolean
  /** E.164 number for this hire (Twilio / carrier) */
  phoneNumber: string
  /** Short display form */
  phoneDisplay: string
  /** Model hints */
  temperature: number
  maxTokens: number
  behavior: AgentBehavior
  /** Full system prompt sent to the model */
  systemPrompt: string
  /** Seed thread for empty chats / landing demo */
  messages: Msg[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** epoch ms. Optional for backwards compat; set by spectrum memory. */
  ts?: number
}
