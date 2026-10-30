import crypto from 'crypto'
import { config } from '../config'

export const ONLINE_ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'] as const
export type OnlineOrderType = (typeof ONLINE_ORDER_TYPES)[number]

// The types switched on under Settings → Online Ordering, in menu order
export const enabledOnlineOrderTypes = (org: { onlineOrderTypes: string[] }): OnlineOrderType[] =>
  ONLINE_ORDER_TYPES.filter((t) => org.onlineOrderTypes.includes(t))

// Domain-separated capabilities: knowing an order number or review link
// never grants access to a customer's online order.
const sign = (id: string) => crypto.createHmac('sha256', `online-track:${config.jwtSecret}`).update(id).digest('base64url')
export const onlineOrderId = (branchId: string, requestId: string) =>
  `online-${crypto.createHmac('sha256', `online-request:${config.jwtSecret}`).update(`${branchId}:${requestId}`).digest('hex')}`
export const onlineTrackingCode = (id: string) => `${id}.${sign(id)}`
export function parseOnlineTrackingCode(code: string): string | null {
  const parts = code.split('.')
  if (parts.length !== 2 || !/^online-[a-f0-9]{64}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null
  return crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(sign(parts[0]))) ? parts[0] : null
}
