import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ExecutionState = {
  version: number
  status: 'working' | 'provider_call' | 'cancelled' | 'cancellation_requested' | 'completed' | 'outcome_unknown'
  updatedAt: number
}

function pathFor(dataDir: string, senderId: string) {
  return join(dataDir, 'executions', `${senderId.replace(/[^\d+a-zA-Z_-]/g, '_')}.json`)
}
export function readExecution(dataDir: string, senderId: string): ExecutionState | null {
  try { return JSON.parse(readFileSync(pathFor(dataDir, senderId), 'utf8')) as ExecutionState } catch { return null }
}
function write(dataDir: string, senderId: string, state: ExecutionState) {
  const path = pathFor(dataDir, senderId); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(state))
  return state
}
export function beginExecution(dataDir: string, senderId: string): ExecutionState {
  const prior = readExecution(dataDir, senderId)
  return write(dataDir, senderId, { version: (prior?.version || 0) + 1, status: 'working', updatedAt: Date.now() })
}
export function markProviderCall(dataDir: string, senderId: string, version: number): ExecutionState | null {
  const state = readExecution(dataDir, senderId)
  if (!state || state.version !== version || state.status !== 'working') return state
  return write(dataDir, senderId, { ...state, status: 'provider_call', updatedAt: Date.now() })
}
export function cancelExecution(dataDir: string, senderId: string): ExecutionState | null {
  const state = readExecution(dataDir, senderId)
  if (!state || !['working', 'provider_call'].includes(state.status)) return state
  return write(dataDir, senderId, { ...state, status: state.status === 'working' ? 'cancelled' : 'cancellation_requested', updatedAt: Date.now() })
}
export function finishExecution(dataDir: string, senderId: string, version: number): ExecutionState | null {
  const state = readExecution(dataDir, senderId)
  if (!state || state.version !== version) return state
  const status = state.status === 'cancellation_requested' ? 'outcome_unknown'
    : state.status === 'cancelled' ? 'cancelled' : 'completed'
  return write(dataDir, senderId, { ...state, status, updatedAt: Date.now() })
}
