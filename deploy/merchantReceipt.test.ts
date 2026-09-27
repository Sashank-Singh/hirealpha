import { expect, it } from 'bun:test'
import { merchantReceiptFromPage, isVerifiedMerchantReceipt } from './merchantReceipt'
const started = Date.parse('2026-09-25T12:00:00Z')
const order = { '@type': 'Order', orderNumber: 'AB123456', orderDate: '2026-09-25T12:01:00Z', orderStatus: 'https://schema.org/OrderProcessing' }
const capture = (data: unknown) => merchantReceiptFromPage({ url: 'https://shop.example/confirmation', jsonLd: [JSON.stringify(data)] }, 'https://shop.example/item', started)
it('UX03 accepts a current structured merchant order and retains its source', () => {
  const receipt = capture(order)
  expect(receipt?.orderId).toBe('AB123456')
  expect(receipt?.sourceUrl).toBe('https://shop.example/confirmation')
  expect(isVerifiedMerchantReceipt(receipt, 'https://shop.example/item', started)).toBe(true)
})
for (const patch of [ { orderNumber: 'unknown' }, { orderNumber: 'unavailable' }, { orderNumber: 'pending' }, { orderDate: '2026-09-24T12:01:00Z' }, { orderStatus: 'https://schema.org/OrderCancelled' }, { '@type': 'Article' } ]) {
  it(`UX03 rejects placeholder/old/unconfirmed receipts ${JSON.stringify(patch)}`, () => expect(capture({ ...order, ...patch })).toBeUndefined())
}
it('UX03 rejects unbound origins and prose even if it contains an ID', () => {
  expect(merchantReceiptFromPage({ url: 'https://other.example/receipt', jsonLd: [JSON.stringify(order)] }, 'https://shop.example/item', started)).toBeUndefined()
  expect(isVerifiedMerchantReceipt('Order number: AB123456', 'https://shop.example/item', started)).toBe(false)
})
