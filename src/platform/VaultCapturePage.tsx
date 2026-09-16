import { getSession } from './roster'
import { VaultApp } from './VaultApp'

export function VaultCapturePage() {
  const session = getSession()
  const params = new URLSearchParams(window.location.search)
  const portal = params.get('portal') || ''
  const persona = params.get('persona') || 'friend'

  return (
    <main className="vault-capture-page">
      <VaultApp
        auth={{
          persona: persona === 'coworker' || persona === 'cofounder' ? persona : 'friend',
          email: session?.email,
        }}
        portal={portal}
        initialUsername={session?.email || ''}
        captureOnly
      />
    </main>
  )
}
