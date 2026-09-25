import { weakEtag, revalidateCacheControl, notModified } from '../httpCache'

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...CORS,
      ...extra,
    },
  })
}

export function appBase(req: Request): string {
  return (process.env.APP_BASE_URL || new URL(req.url).origin).replace(/\/$/, '')
}

export function jsonRevalidated(req: Request, swrSeconds: number, data: unknown): Response {
  const body = JSON.stringify(data)
  const etag = weakEtag(body)
  const cache = revalidateCacheControl(swrSeconds)
  if (notModified(req.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cache, ...CORS } })
  }
  return new Response(body, {
    headers: { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': cache, ...CORS },
  })
}

export async function fetchPublic(url: URL, init: RequestInit, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch {
    return new Response(null, { status: 504 })
  } finally {
    clearTimeout(timer)
  }
}
