export const LOGIN_SCOPES = 'openid email profile'
export const LOGIN_STATE_USER = 'login'

export function googleCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID || ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || ''
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}
