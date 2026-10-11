import { AppError } from '../middleware/error'

// Payment buckets are actual VAT-inclusive receipts, after discounts/refunds.
// Discount/refund fields describe pre-tax adjustments already reflected there.
export function calculateSaleAmounts(sale: {
  cashAmount: number; cardAmount: number; bankTransferAmount: number; otherAmount: number; deliveryAmount: number
  vatRate: number; discountAmount: number; refundAmount: number
  deliveryBreakdown?: { amount: number; commission: number; netAmount: number; platform: string }[]
}) {
  const round = (n: number) => Math.round(n * 100) / 100
  for (const value of [sale.cashAmount, sale.cardAmount, sale.bankTransferAmount, sale.otherAmount, sale.deliveryAmount, sale.vatRate, sale.discountAmount, sale.refundAmount]) {
    if (!Number.isFinite(value) || value < 0) throw new AppError('Sales amounts must be finite and nonnegative', 400, 'VALIDATION_ERROR')
  }
  if (sale.vatRate > 100) throw new AppError('Invalid sales VAT rate', 400, 'VALIDATION_ERROR')
  const receipts = { cashAmount: round(sale.cashAmount), cardAmount: round(sale.cardAmount), bankTransferAmount: round(sale.bankTransferAmount), otherAmount: round(sale.otherAmount), deliveryAmount: round(sale.deliveryAmount) }
  const totalAmount = round(Object.values(receipts).reduce((sum, value) => sum + value, 0))
  const netAmount = round(totalAmount / (1 + sale.vatRate / 100))
  const vatAmount = round(totalAmount - netAmount)
  const subtotal = round(netAmount + sale.discountAmount + sale.refundAmount)
  const deliveryBreakdown = sale.deliveryBreakdown?.map((line) => {
    if (![line.amount, line.commission].every((n) => Number.isFinite(n) && n >= 0) || line.commission > line.amount) throw new AppError('Invalid delivery amount or commission', 400, 'VALIDATION_ERROR')
    return { ...line, amount: round(line.amount), commission: round(line.commission), netAmount: round(line.amount - line.commission) }
  })
  if (deliveryBreakdown?.length && Math.round(deliveryBreakdown.reduce((sum, line) => sum + line.amount, 0) * 100) !== Math.round(sale.deliveryAmount * 100)) throw new AppError('Delivery breakdown does not reconcile to delivery receipts', 400, 'SALE_TOTAL_MISMATCH')
  return { ...receipts, discountAmount: round(sale.discountAmount), refundAmount: round(sale.refundAmount), subtotal, vatAmount, totalAmount, netAmount, ...(deliveryBreakdown && { deliveryBreakdown }) }
}
