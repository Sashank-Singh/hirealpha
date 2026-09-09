import { describe, expect, it } from 'bun:test'
import { paramsForWorkspaceView, workspaceViewFromParams } from './workspaceNavigation'

describe('workspace sidebar URL state', () => {
  it('keeps legacy Vault links working on first load', () => {
    expect(workspaceViewFromParams(new URLSearchParams('vault=1&tab=workspace'))).toBe('vault')
  })

  it('removes a legacy Vault override when Workspace is clicked', () => {
    const next = paramsForWorkspaceView(new URLSearchParams('vault=1&tab=workspace&keep=yes'), 'workspace')
    expect(next.get('vault')).toBeNull()
    expect(next.get('tab')).toBe('workspace')
    expect(next.get('keep')).toBe('yes')
    expect(workspaceViewFromParams(next)).toBe('workspace')
  })

  it('removes payment callback overrides when another tab is clicked', () => {
    for (const query of ['connect=payments&tab=workspace', 'payments=connected&tab=vault']) {
      const next = paramsForWorkspaceView(new URLSearchParams(query), 'vault')
      expect(next.get('connect')).toBeNull()
      expect(next.get('payments')).toBeNull()
      expect(workspaceViewFromParams(next)).toBe('vault')
    }
  })
})
