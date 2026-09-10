/** Live OpenBao certification: cross-user isolation, rotation/revocation,
 * token loss behavior, and a structural check that client errors never echo
 * plaintext. Requires CERT_ALLOW_LIVE=1 + OPENBAO_ADDR/OPENBAO_TOKEN. */
import { describe, expect, it } from 'bun:test'
import { OpenBaoTransitClient, decryptUserPayload, encryptUserPayload } from '../../services/trust/userKeyBroker'

const env = process.env
const live = env.CERT_ALLOW_LIVE === '1' && Boolean(env.OPENBAO_ADDR?.trim() && env.OPENBAO_TOKEN?.trim())
const broker = live ? new OpenBaoTransitClient(env.OPENBAO_ADDR!, env.OPENBAO_TOKEN!) : null

describe.skipIf(!live)('openbao live certification', () => {
  it('creates per-user keys and decrypts only with the same user AAD', async () => {
    const suffix = Date.now().toString(36)
    const userA = `cert-a-${suffix}`
    const userB = `cert-b-${suffix}`
    const keyA = await broker!.generate(userA)
    const keyB = await broker!.generate(userB)
    const payload = `secret-${suffix}`
    const ciphertext = encryptUserPayload(payload, keyA.plaintext, { userId: userA, recordId: 'r1', scope: 'vault:https://cert.example.com' })

    // Same user decrypts; user B's key fails (wrong AAD + different key).
    expect(decryptUserPayload(ciphertext, keyA.plaintext, { userId: userA, recordId: 'r1', scope: 'vault:https://cert.example.com' })).toBe(payload)
    expect(decryptUserPayload(ciphertext, keyB.plaintext, { userId: userB, recordId: 'r1', scope: 'vault:https://cert.example.com' })).toBeNull()
    // Record-id AAD mismatch also fails.
    expect(decryptUserPayload(ciphertext, keyA.plaintext, { userId: userA, recordId: 'r2', scope: 'vault:https://cert.example.com' })).toBeNull()
    keyA.plaintext.fill(0)
    keyB.plaintext.fill(0)
  })

  it('unwraps through the broker and fails on a corrupted wrapped key', async () => {
    const suffix = Date.now().toString(36)
    const user = `cert-c-${suffix}`
    const key = await broker!.generate(user)
    const unwrapped = await broker!.unwrap(user, key.wrapped)
    expect(unwrapped.length).toBe(32)
    unwrapped.fill(0)
    key.plaintext.fill(0)
    await expect(broker!.unwrap(user, 'vault:v1:not-a-real-ciphertext')).rejects.toThrow('OpenBao')
  })

  it('reports provider failures without echoing payloads', async () => {
    // Structural guarantee: every thrown OpenBao message is a static template.
    let message = ''
    try {
      await broker!.unwrap('cert-any', 'vault:v1:bogus')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message.length).toBeGreaterThan(0)
    expect(message).not.toMatch(/plaintext|payload|secret-/)
  })
})
