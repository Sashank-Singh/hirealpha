import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatMessage } from '../../src/agents/types'

const MAX_MESSAGES = 40

function threadPath(dataDir: string, senderId: string) {
  const safe = senderId.replace(/[^\d+a-zA-Z_-]/g, '_')
  return join(dataDir, 'threads', `${safe}.json`)
}

export function loadThread(dataDir: string, senderId: string): ChatMessage[] {
  const path = threadPath(dataDir, senderId)
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ChatMessage[]
    return Array.isArray(raw) ? raw.slice(-MAX_MESSAGES) : []
  } catch {
    return []
  }
}

export function appendThread(
  dataDir: string,
  senderId: string,
  messages: ChatMessage[],
) {
  const path = threadPath(dataDir, senderId)
  mkdirSync(dirname(path), { recursive: true })
  const prev = loadThread(dataDir, senderId)
  const next = [...prev, ...messages].slice(-MAX_MESSAGES)
  writeFileSync(path, JSON.stringify(next, null, 2))
  return next
}
