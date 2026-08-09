/** Production origin used for canonical, Open Graph, and sitemap URLs. */
export const SITE_URL = (
  import.meta.env.VITE_SITE_URL || 'https://hirealpha.com'
).replace(/\/$/, '')

export const SITE_NAME = 'HireAlpha'

export const DEFAULT_TITLE =
  'HireAlpha — Hire Friend, Coworker & Cofounder in iMessage'

export const DEFAULT_DESCRIPTION =
  'HireAlpha puts three hireable AI agents in iMessage: Friend, Coworker, and Cofounder. Separate numbers, real personalities, $19/mo each. Not one chatbot with modes.'

export const DEFAULT_KEYWORDS = [
  'HireAlpha',
  'AI in iMessage',
  'hire AI agent',
  'iMessage AI assistant',
  'AI coworker',
  'AI cofounder',
  'AI friend',
  'text AI agents',
  'Messages AI',
].join(', ')
