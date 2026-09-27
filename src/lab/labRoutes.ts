/* Route table for the email prototype.
 *
 * One module so the brief and the router cannot drift apart. The older paths
 * are kept as redirects because they were shared while the other two concepts
 * were still under review.
 */
export const LAB_ROUTES = {
  brief: '/lab/brief',
  legacy: ['/lab', '/lab/email', '/lab/email-v1', '/lab/email-v2', '/lab/email-v3', '/lab/email-compare'],
} as const
