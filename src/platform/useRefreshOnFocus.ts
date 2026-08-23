import { useEffect, useRef } from 'react'

/** Re-run a loader when the window regains focus. Mini-apps fetch once on
 * mount, so a log that lands over iMessage while the screen is open stays
 * invisible until the user reopens it — refresh on tab/app switch instead. */
export function useRefreshOnFocus(load: () => void) {
  const ref = useRef(load)
  ref.current = load
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') ref.current()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
}
