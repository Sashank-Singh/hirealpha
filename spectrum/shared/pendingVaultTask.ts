import { setPendingVaultTask, type ThreadMemory } from './memory'

type Pending = NonNullable<ThreadMemory['pendingVaultTask']>
type Proposal = { ok?: boolean; needsVault?: boolean; error?: unknown; id?: string; sessionUrl?: string }

/** Persist every transition before/after the external enqueue. */
export async function enqueuePendingVaultTask(
  dataDir: string,
  senderId: string,
  pending: Pending,
  propose: () => Promise<Proposal>,
): Promise<Proposal> {
  setPendingVaultTask(dataDir, senderId, { ...pending, state: 'preparing', lastError: undefined })
  try {
    const result = await propose()
    if (result.ok && !result.needsVault) {
      setPendingVaultTask(dataDir, senderId)
    } else {
      setPendingVaultTask(dataDir, senderId, {
        ...pending,
        state: result.needsVault ? 'pending' : 'retryable_failure',
        lastError: result.needsVault ? 'login missing' : String(result.error || 'enqueue failed').slice(0, 300),
      })
    }
    return result
  } catch (error) {
    setPendingVaultTask(dataDir, senderId, {
      ...pending, state: 'retryable_failure',
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    })
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
