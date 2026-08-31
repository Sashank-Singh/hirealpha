import { useMemo } from 'react'
import type { FeatureAuth } from './FeatureMiniApps'

/**
 * A stable { email, token, persona } view of the auth prop.
 *
 * Mini-app pages receive `auth` as an inline JSX object, so its identity changes
 * on every parent render. Dependency arrays that list the object directly would
 * re-run their effects forever; listing the fields scatter them across dozens of
 * callbacks. Memoizing on the primitive fields gives one identity that changes
 * exactly when the credentials do, which is what every dep array wants.
 */
export function useStableAuth(auth: FeatureAuth) {
  return useMemo(
    () => ({ email: auth.email, token: auth.token, persona: auth.persona }),
    [auth.email, auth.token, auth.persona],
  )
}
