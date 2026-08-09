import { SITE_URL, SITE_NAME, DEFAULT_DESCRIPTION } from './config'

/** JSON-LD graph for Organization + SoftwareApplication + FAQ + WebSite. */
export function buildHomeJsonLd(faq: { question: string; answer: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: SITE_NAME,
        url: SITE_URL,
        logo: `${SITE_URL}/favicon.svg`,
        description: DEFAULT_DESCRIPTION,
        sameAs: [],
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: SITE_URL,
        name: SITE_NAME,
        description: DEFAULT_DESCRIPTION,
        publisher: { '@id': `${SITE_URL}/#organization` },
        inLanguage: 'en-US',
      },
      {
        '@type': 'WebPage',
        '@id': `${SITE_URL}/#webpage`,
        url: SITE_URL,
        name: 'HireAlpha — Hire Friend, Coworker & Cofounder in iMessage',
        isPartOf: { '@id': `${SITE_URL}/#website` },
        about: { '@id': `${SITE_URL}/#organization` },
        description: DEFAULT_DESCRIPTION,
        inLanguage: 'en-US',
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#app`,
        name: SITE_NAME,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'iOS, macOS',
        description: DEFAULT_DESCRIPTION,
        url: SITE_URL,
        offers: [
          {
            '@type': 'Offer',
            name: 'Friend',
            price: '19.00',
            priceCurrency: 'USD',
            description: 'Personal companion in iMessage',
          },
          {
            '@type': 'Offer',
            name: 'Coworker',
            price: '19.00',
            priceCurrency: 'USD',
            description: 'Work colleague in iMessage',
          },
          {
            '@type': 'Offer',
            name: 'Cofounder',
            price: '19.00',
            priceCurrency: 'USD',
            description: 'Startup partner in iMessage',
          },
        ],
      },
      {
        '@type': 'FAQPage',
        '@id': `${SITE_URL}/#faq`,
        mainEntity: faq.map((item) => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: {
            '@type': 'Answer',
            text: item.answer,
          },
        })),
      },
    ],
  }
}
