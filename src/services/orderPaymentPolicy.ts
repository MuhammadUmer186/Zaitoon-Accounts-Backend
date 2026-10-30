import { AppError } from '../middleware/error'

type OrderState = { status: string; items: { status: string }[] }
export function readyForPayment(order: OrderState) {
  const active = order.items.filter((item) => item.status !== 'cancelled')
  return order.status === 'open' && active.length > 0 && active.every((item) => item.status !== 'awaiting')
}
export function assertReadyForPayment(order: OrderState) {
  if (!['open', 'pending'].includes(order.status)) throw new AppError('This order is no longer open for payment.', 409, 'INVALID_STATUS')
  if (!readyForPayment(order)) throw new AppError('Wait for staff to accept all dishes before paying. Full payment then confirms the order for preparation.', 409, 'NOT_ACCEPTED')
}

export function estimatedReadyAfterPayment(order: { acceptedAt: Date | null; estimatedReadyAt: Date | null }, paidAt: Date) {
  if (!order.acceptedAt || !order.estimatedReadyAt) return undefined
  const preparationMs = Math.max(0, order.estimatedReadyAt.getTime() - order.acceptedAt.getTime())
  return new Date(paidAt.getTime() + preparationMs)
}
