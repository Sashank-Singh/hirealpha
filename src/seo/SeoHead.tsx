import { useEffect } from 'react'
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  SITE_NAME,
  SITE_URL,
} from './config'

type SeoHeadProps = {
  title?: string
  description?: string
  path?: string
  image?: string
  noIndex?: boolean
  type?: 'website' | 'article'
}

function upsertMeta(
  attr: 'name' | 'property',
  key: string,
  content: string,
) {
  let el = document.head.querySelector<HTMLMetaElement>(
    `meta[${attr}="${key}"]`,
  )
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function upsertLink(rel: string, href: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', rel)
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}

/** Keeps document head in sync for SPA routes (title, canonical, social). */
export function SeoHead({
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  path = '/',
  image = '/og-image.jpg',
  noIndex = false,
  type = 'website',
}: SeoHeadProps) {
  useEffect(() => {
    const url = `${SITE_URL}${path === '/' ? '' : path}`
    const imageUrl = image.startsWith('http') ? image : `${SITE_URL}${image}`

    document.title = title

    upsertMeta('name', 'description', description)
    upsertMeta('name', 'robots', noIndex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large')
    upsertMeta('name', 'googlebot', noIndex ? 'noindex, nofollow' : 'index, follow')

    upsertMeta('property', 'og:title', title)
    upsertMeta('property', 'og:description', description)
    upsertMeta('property', 'og:url', url)
    upsertMeta('property', 'og:type', type)
    upsertMeta('property', 'og:image', imageUrl)
    upsertMeta('property', 'og:site_name', SITE_NAME)

    upsertMeta('name', 'twitter:title', title)
    upsertMeta('name', 'twitter:description', description)
    upsertMeta('name', 'twitter:image', imageUrl)
    upsertMeta('name', 'twitter:url', url)

    upsertLink('canonical', url)
  }, [title, description, path, image, noIndex, type])

  return null
}
