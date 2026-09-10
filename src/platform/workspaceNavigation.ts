import type { SettingsView } from './SettingsSheet'

/** Resolve old task/payment deep links without letting them trap later clicks. */
export function workspaceViewFromParams(params: URLSearchParams): SettingsView {
  const tab = params.get('tab')
  if (params.get('vault') === '1') return 'vault'
  if (params.get('connect') === 'payments' || params.get('payments') === 'connected') return 'payments'
  return tab === 'vault' || tab === 'payments' || tab === 'memory' || tab === 'trust' ? tab : 'workspace'
}

/**
 * Sidebar navigation becomes the new source of truth after a user clicks it.
 * Legacy one-shot deep-link flags must be removed or they keep overriding tab.
 */
export function paramsForWorkspaceView(params: URLSearchParams, view: SettingsView): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('vault')
  next.delete('connect')
  next.delete('payments')
  next.set('tab', view)
  return next
}
