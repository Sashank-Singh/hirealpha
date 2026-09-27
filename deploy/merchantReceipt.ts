/** Merchant evidence is collected from the page, never from an agent's answer. */
export type MerchantReceipt = {
  orderId: string; sourceUrl: string; orderedAt: string; observedAt: string
  source: 'merchant-jsonld'; status: 'OrderProcessing' | 'OrderInTransit' | 'OrderDelivered'
}
export type BrowserResult = { ok: true; content: string; receipt?: MerchantReceipt } | { ok: false; error: string }

export function receiptPageSnapshot(): { url: string; jsonLd: string[] } {
  return { url: location.href, jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => s.textContent || '').slice(0, 20) }
}
export function isVerifiedMerchantReceipt(value: unknown, merchantUrl?: string, notBefore = 0): value is MerchantReceipt {
  if (!value || typeof value !== 'object') return false
  const r = value as MerchantReceipt
  if (r.source !== 'merchant-jsonld' || !['OrderProcessing', 'OrderInTransit', 'OrderDelivered'].includes(r.status)) return false
  if (typeof r.orderId !== 'string' || !/^[a-z0-9][a-z0-9-]{3,79}$/i.test(r.orderId) || !/\d/.test(r.orderId)
    || /unknown|unavailable|pending|placeholder|example|test|null|none/i.test(r.orderId)) return false
  const ordered = Date.parse(r.orderedAt), observed = Date.parse(r.observedAt)
  if (!Number.isFinite(ordered) || !Number.isFinite(observed) || ordered < notBefore || observed < ordered || observed > Date.now() + 60_000) return false
  try {
    const source = new URL(r.sourceUrl)
    return source.protocol === 'https:' && !source.username && !source.password && (!merchantUrl || source.origin === new URL(merchantUrl).origin)
  } catch { return false }
}
export function merchantReceiptFromPage(snapshot: { url: string; jsonLd: string[] }, merchantUrl: string, notBefore: number): MerchantReceipt | undefined {
  const visit = (value: unknown): MerchantReceipt | undefined => {
    if (Array.isArray(value)) { for (const entry of value) { const found = visit(entry); if (found) return found } return }
    if (!value || typeof value !== 'object') return
    const data = value as Record<string, unknown>
    if (data['@graph']) { const found = visit(data['@graph']); if (found) return found }
    if (data['@type'] !== 'Order') return
    const receipt = {
      orderId: String(data.orderNumber || ''), sourceUrl: snapshot.url,
      orderedAt: String(data.orderDate || ''), observedAt: new Date().toISOString(),
      source: 'merchant-jsonld', status: String(data.orderStatus || '').replace(/^https?:\/\/schema.org\//, ''),
    }
    return isVerifiedMerchantReceipt(receipt, merchantUrl, notBefore) ? receipt : undefined
  }
  for (const block of snapshot.jsonLd) { try { const receipt = visit(JSON.parse(block)); if (receipt) return receipt } catch { /* malformed merchant data is not evidence */ } }
}
