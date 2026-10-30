import type { AdapterContext, PaymentAdapter } from './adapters'

// Official API: https://docs.moyasar.com/category/invoices-api
// Hosted checkout keeps card data at Moyasar. Every notification is independently
// fetched with the merchant secret; callback claims never establish payment.
type Payment = { id: string; status: string; amount: number; currency: string; refunded?: number; source?: { company?: string } }
type Invoice = { id: string; status: string; amount: number; currency: string; url: string; metadata?: Record<string, string>; payments?: Payment[] }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export async function moyasarRequest<T>(ctx: AdapterContext, path: string, body?: unknown): Promise<T> {
  const prefix = ctx.environment === 'production' ? 'sk_live_' : 'sk_test_'
  if (!ctx.secret?.startsWith(prefix)) throw new Error(`Enter a Moyasar ${ctx.environment} secret key in payment settings`)
  const response = await fetch(`https://api.moyasar.com/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Basic ${Buffer.from(`${ctx.secret}:`).toString('base64')}`, 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`Moyasar request failed (${response.status}); review the merchant account and payment settings`)
  return await response.json() as T
}
export const moyasar: PaymentAdapter = {
  key: 'moyasar', label: 'Moyasar hosted checkout (MADA & cards)', channels: ['qr', 'kiosk', 'terminal'], sandboxOnly: false,
  async create(ctx, intent) {
    if (ctx.currency !== 'SAR') throw new Error('MADA checkout requires SAR as the organization currency')
    const apiBase = process.env.PAYMENT_CALLBACK_BASE_URL?.replace(/\/$/, '')
    if (!apiBase || !apiBase.startsWith('https://')) throw new Error('Set PAYMENT_CALLBACK_BASE_URL to the public HTTPS API base URL including /api/v1')
    const invoice = await moyasarRequest<Invoice>(ctx, 'invoices', {
      amount: Math.round(intent.amount * 100), currency: intent.currency, description: `FoodSync payment ${intent.id}`,
      expired_at: new Date(Date.now() + 20 * 60000).toISOString(),
      callback_url: `${apiBase}/payments/callbacks/moyasar?organizationId=${encodeURIComponent(ctx.organizationId)}`,
      metadata: { organizationId: ctx.organizationId, intentId: intent.id },
    })
    if (!uuid.test(invoice.id)) throw new Error('Moyasar returned an invalid invoice ID')
    const url = new URL(invoice.url)
    if (url.hostname !== 'checkout.moyasar.com' || url.protocol !== 'https:') throw new Error('Moyasar returned an unexpected checkout URL')
    return { providerRef: invoice.id, checkoutUrl: url.toString() }
  },
  async verifyCallback(headers, raw, keyFor) {
    const { CallbackRejected } = await import('./adapters')
    let payload: { id?: string; organizationId?: string; data?: { id?: string } }
    try { payload = JSON.parse(raw.toString('utf8')) } catch { throw new CallbackRejected('Invalid invoice notification', 'INVALID_PAYLOAD') }
    const organizationId = String(headers['x-foodsync-organization'] ?? payload.organizationId ?? '')
    const invoiceId = payload.id ?? payload.data?.id ?? ''
    if (!uuid.test(invoiceId) || !organizationId) throw new CallbackRejected('Invalid invoice notification', 'INVALID_PAYLOAD')
    const ctx = await keyFor(organizationId)
    if (!ctx) throw new CallbackRejected('Unknown merchant', 'UNKNOWN_MERCHANT')
    const invoice = await moyasarRequest<Invoice>(ctx, `invoices/${invoiceId}`)
    if (invoice.id !== invoiceId || invoice.metadata?.organizationId !== organizationId) throw new CallbackRejected('Invoice does not belong to this merchant', 'MERCHANT_MISMATCH')
    const payment = invoice.payments?.find((p) => ['paid', 'captured'].includes(p.status))
    if (invoice.status !== 'paid' || !payment) throw new CallbackRejected('Payment has not been captured', 'PAYMENT_PENDING')
    if (!Number.isSafeInteger(invoice.amount) || invoice.amount <= 0 || !uuid.test(payment.id) || payment.amount !== invoice.amount || payment.currency !== invoice.currency || (payment.refunded ?? 0) > 0) throw new CallbackRejected('Invoice payment amount does not match', 'AMOUNT_MISMATCH')
    return { eventId: `moyasar:${invoice.id}:${payment.id}:paid`, providerRef: invoice.id, organizationId,
      type: 'payment.succeeded', amount: invoice.amount / 100, currency: invoice.currency, merchantId: ctx.merchantId,
      method: payment.source?.company === 'mada' ? 'mada' : 'card' }
  },
  async refund(ctx, intent, amount) {
    if (!intent.providerRef || !uuid.test(intent.providerRef)) throw new Error('Missing Moyasar invoice')
    const invoice = await moyasarRequest<Invoice>(ctx, `invoices/${intent.providerRef}`)
    const payment = invoice.payments?.find((p) => ['paid', 'captured', 'refunded'].includes(p.status))
    if (!payment || payment.amount !== Math.round(intent.amount * 100) || payment.currency !== intent.currency) throw new Error('Could not identify the original captured payment')
    const requested = Math.round(amount * 100)
    if ((payment.refunded ?? 0) >= requested) return { refundRef: payment.id, status: 'refunded' }
    if ((payment.refunded ?? 0) > 0) throw new Error('Payment was partially refunded externally; reconcile in Moyasar')
    const refunded = await moyasarRequest<Payment>(ctx, `payments/${payment.id}/refund`, { amount: requested })
    return { refundRef: payment.id, status: (refunded.refunded ?? 0) >= requested ? 'refunded' : 'pending' }
  },
}
