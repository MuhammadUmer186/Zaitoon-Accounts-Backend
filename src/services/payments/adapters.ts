import crypto from 'node:crypto'
import { moyasar } from './moyasar'
import { config } from '../../config'

// Payment integrations behind one interface. FoodSync never treats a payment
// as made because credentials were saved: money is applied only from a
// verified callback (or a verified status fetch) whose amount, currency and
// merchant match the intent.
//
// Adapters are registered below. Live merchant acceptance remains a separate
// deployment check; a successful simulator test never establishes real payment.

export type Channel = 'qr' | 'kiosk' | 'terminal'
export interface AdapterContext { organizationId: string; environment: 'sandbox' | 'production'; merchantId: string; currency: string; secret: string | null }
export interface IntentRef { id: string; amount: number; currency: string; channel: Channel; providerRef: string | null }
export interface CreateResult { providerRef: string; checkoutUrl?: string }
export interface VerifiedEvent {
  eventId: string; providerRef: string; organizationId: string
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'refund.failed'
  amount: number; currency: string; merchantId: string; reason?: string; method?: 'card' | 'mada'
}
export interface RefundResult { refundRef: string; status: 'refunded' | 'pending' | 'failed'; reason?: string }

export interface PaymentAdapter {
  key: string
  label: string
  channels: Channel[]
  /** usable only with the sandbox environment */
  sandboxOnly: boolean
  create(ctx: AdapterContext, intent: IntentRef): Promise<CreateResult>
  /** throws when the signature, timestamp or payload is not valid */
  verifyCallback(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, keyFor: (organizationId: string) => Promise<AdapterContext | null>): Promise<VerifiedEvent>
  refund(ctx: AdapterContext, intent: IntentRef, amount: number, idempotencyKey: string): Promise<RefundResult>
}

export class CallbackRejected extends Error { constructor(message: string, public code: string) { super(message) } }

// ── Sandbox simulator ───────────────────────────────────────────────────────
// Behaves like a hosted-page / terminal gateway so the whole flow (intent,
// redirect or terminal wait, signed callback, settlement, refund) can be
// tested end to end. Its callbacks are HMAC-SHA256 signed with a per-
// organization key and carry a timestamp checked for replay.
const SIM_TOLERANCE_MS = 5 * 60_000
export const simulatorKey = (organizationId: string) => crypto.createHmac('sha256', `${config.jwtSecret}:payments-simulator`).update(organizationId).digest()
export function signSimulatorEvent(organizationId: string, body: string, timestamp = Date.now()) {
  return { 'x-simulator-timestamp': String(timestamp), 'x-simulator-signature': crypto.createHmac('sha256', simulatorKey(organizationId)).update(`${timestamp}.${body}`).digest('hex') }
}

const simulator: PaymentAdapter = {
  key: 'simulator',
  label: 'Sandbox simulator (no real money)',
  channels: ['qr', 'kiosk', 'terminal'],
  sandboxOnly: true,
  async create(_ctx, intent) {
    return { providerRef: `sim_${intent.id}_${crypto.randomBytes(6).toString('hex')}` }
  },
  async verifyCallback(headers, rawBody, keyFor) {
    const header = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v }
    const signature = header('x-simulator-signature'), ts = Number(header('x-simulator-timestamp'))
    if (!signature || !Number.isFinite(ts)) throw new CallbackRejected('Missing signature', 'SIGNATURE_MISSING')
    if (Math.abs(Date.now() - ts) > SIM_TOLERANCE_MS) throw new CallbackRejected('Callback timestamp outside the allowed window', 'STALE_CALLBACK')
    let payload: Partial<VerifiedEvent>
    try { payload = JSON.parse(rawBody.toString('utf8')) } catch { throw new CallbackRejected('Invalid payload', 'INVALID_PAYLOAD') }
    if (!payload || typeof payload !== 'object' || [payload.organizationId, payload.eventId, payload.providerRef, payload.type].some(v => typeof v !== 'string' || !v)) throw new CallbackRejected('Invalid payload', 'INVALID_PAYLOAD')
    const ctx = await keyFor(payload.organizationId!)
    if (!ctx) throw new CallbackRejected('Unknown merchant', 'UNKNOWN_MERCHANT')
    const expected = crypto.createHmac('sha256', simulatorKey(payload.organizationId!)).update(`${ts}.${rawBody.toString('utf8')}`).digest()
    const given = Buffer.from(signature, 'hex')
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new CallbackRejected('Signature does not match', 'SIGNATURE_INVALID')
    if (!['payment.succeeded', 'payment.failed', 'refund.succeeded', 'refund.failed'].includes(String(payload.type))) throw new CallbackRejected('Unknown event type', 'INVALID_PAYLOAD')
    if (typeof payload.amount !== 'number' || !Number.isFinite(payload.amount) || payload.amount <= 0 || typeof payload.currency !== 'string' || !payload.currency || typeof payload.merchantId !== 'string') throw new CallbackRejected('Invalid payment fields', 'INVALID_PAYLOAD')
    return { eventId: payload.eventId!, providerRef: payload.providerRef!, organizationId: payload.organizationId!, type: payload.type as VerifiedEvent['type'], amount: payload.amount, currency: payload.currency, merchantId: payload.merchantId, reason: typeof payload.reason === 'string' ? payload.reason : undefined }
  },
  async refund(_ctx, intent) {
    return { refundRef: `simr_${intent.id}_${crypto.randomBytes(4).toString('hex')}`, status: 'refunded' }
  },
}

const REGISTRY: Record<string, PaymentAdapter> = { simulator, moyasar }
export const adapterFor = (key: string): PaymentAdapter | null => REGISTRY[key] ?? null
export const adapterOptions = () => [{ value: 'none', label: 'None (payments collected at the till)', sandboxOnly: false }, ...Object.values(REGISTRY).map((a) => ({ value: a.key, label: a.label, sandboxOnly: a.sandboxOnly }))]
