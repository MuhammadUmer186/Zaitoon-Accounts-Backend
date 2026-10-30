import crypto from 'crypto'
import { config } from '../config'

// Per-order review links for the QR printed on receipts:
// "<orderId>.<signature>". The signature (HMAC with the server secret) means
// a link can't be guessed or edited to rate somebody else's order, without
// storing anything extra per order.
const sign = (orderId: string) =>
  crypto.createHmac('sha256', `review:${config.jwtSecret}`).update(orderId).digest('base64url').slice(0, 16)

export const makeReviewCode = (orderId: string) => `${orderId}.${sign(orderId)}`

export function parseReviewCode(code: string): string | null {
  const [orderId, sig] = code.split('.')
  if (!orderId || !sig || sig.length !== 16) return null
  const expected = sign(orderId)
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? orderId : null
}
